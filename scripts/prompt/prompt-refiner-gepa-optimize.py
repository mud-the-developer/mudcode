#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from difflib import SequenceMatcher
from importlib import metadata as importlib_metadata
from pathlib import Path
from typing import Any, NamedTuple

try:
    import gepa
except Exception:
    gepa = None


class EvaluationResult(NamedTuple):
    score: float
    feedback: str
    objective_scores: dict[str, float] | None = None


def _default_train_path() -> Path:
    return Path.cwd() / ".mudcode" / "gepa" / "prompt-refiner-gepa-train.jsonl"


def _default_val_path() -> Path:
    return Path.cwd() / ".mudcode" / "gepa" / "prompt-refiner-gepa-val.jsonl"


def _default_run_dir() -> Path:
    return Path.cwd() / ".mudcode" / "gepa" / "run"


def _default_activate_path() -> Path:
    return Path.home() / ".mudcode" / "prompt-refiner-active-policy.txt"


def _default_activate_config_path() -> Path:
    return Path.home() / ".mudcode" / "config.json"


def _default_seed_prompt() -> str:
    return (
        "You are a prompt refiner for user requests.\n"
        "Rewrite the user text to be clearer while preserving intent.\n"
        "Rules:\n"
        "- Keep the original language and tone.\n"
        "- Keep technical meaning unchanged.\n"
        "- Do not add new requirements.\n"
        "- Return only the rewritten text.\n"
    )


def _default_activate_min_improvement() -> float:
    raw = os.getenv("MUDCODE_GEPA_ACTIVATE_MIN_IMPROVEMENT", "0.01")
    try:
        value = float(raw)
    except Exception:
        return 0.01
    if value < 0:
        return 0.0
    return value


def _normalize_spaces(text: str) -> str:
    return " ".join(text.strip().split())


def _token_f1(a: str, b: str) -> float:
    ta = a.split()
    tb = b.split()
    if not ta and not tb:
        return 1.0
    if not ta or not tb:
        return 0.0
    common = 0
    counts: dict[str, int] = {}
    for t in ta:
        counts[t] = counts.get(t, 0) + 1
    for t in tb:
        c = counts.get(t, 0)
        if c > 0:
            common += 1
            counts[t] = c - 1
    if common == 0:
        return 0.0
    precision = common / len(tb)
    recall = common / len(ta)
    return 2 * precision * recall / (precision + recall)


@dataclass
class PromptSample:
    prompt: str
    target: str
    sample_id: str
    changed: bool


def load_jsonl(path: Path, limit: int | None = None, changed_only: bool = False) -> list[PromptSample]:
    if not path.exists():
        raise FileNotFoundError(f"dataset not found: {path}")
    rows: list[PromptSample] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            parsed = json.loads(line)
            prompt = str(parsed.get("prompt", ""))
            target = str(parsed.get("target", ""))
            if prompt == "" or target == "":
                continue
            changed = bool((parsed.get("meta") or {}).get("changed", False))
            if changed_only and not changed:
                continue
            sample_id = str(parsed.get("id", f"row-{len(rows)}"))
            rows.append(PromptSample(prompt=prompt, target=target, sample_id=sample_id, changed=changed))
            if limit is not None and len(rows) >= limit:
                break
    return rows


def to_gepa_dataset(rows: list[PromptSample]) -> list[dict[str, Any]]:
    return [
        {
            "input": row.prompt,
            "additional_context": {"sample_id": row.sample_id},
            "answer": row.target,
        }
        for row in rows
    ]


class PromptRefinerEvaluator:
    def __call__(self, data: dict[str, Any], response: str) -> EvaluationResult:
        answer = str(data["answer"])
        resp = str(response or "")
        resp_norm = _normalize_spaces(resp)
        answer_norm = _normalize_spaces(answer)

        exact_raw = resp == answer
        exact_norm = resp_norm == answer_norm
        contains_exact_norm = bool(answer_norm) and answer_norm in resp_norm
        seq = SequenceMatcher(a=answer_norm, b=resp_norm).ratio() if answer_norm or resp_norm else 1.0
        f1 = _token_f1(answer_norm, resp_norm)

        if exact_raw:
            score = 1.0
        elif exact_norm:
            score = 0.97
        else:
            overlap = max(0.0, min(1.0, 0.65 * f1 + 0.35 * seq))
            if contains_exact_norm:
                extra_chars = max(0, len(resp_norm) - len(answer_norm))
                extra_ratio = extra_chars / max(1, len(resp_norm))
                score = max(0.0, min(0.9, overlap * (1.0 - 0.35 * extra_ratio)))
            else:
                score = max(0.0, min(0.9, overlap))

        feedback = (
            f"Target: {answer}\n"
            f"Generated: {resp}\n"
            f"exact_raw={exact_raw}, exact_norm={exact_norm}, contains_exact_norm={contains_exact_norm}, token_f1={f1:.3f}, seq={seq:.3f}\n"
            "Improve faithfulness to the target rewrite while preserving intent and language."
        )
        return EvaluationResult(score=score, feedback=feedback, objective_scores=None)


def heuristic_task_model(messages: list[dict[str, str]]) -> str:
    system = (messages[0].get("content", "") if messages else "").lower()
    user = messages[-1].get("content", "") if messages else ""
    out = user

    if "trim" in system:
        out = out.strip()
    if "collapse" in system or "spaces" in system:
        out = _normalize_spaces(out)
    if "remove duplicate punctuation" in system:
        while "??" in out or "!!" in out:
            out = out.replace("??", "?").replace("!!", "!")
    if "no trailing period" in system and out.endswith("."):
        out = out[:-1]
    return out


def heuristic_candidate_proposer(
    candidate: dict[str, str],
    _reflective_dataset: dict[str, list[dict[str, Any]]],
    components_to_update: list[str],
) -> dict[str, str]:
    updated = dict(candidate)
    for comp in components_to_update:
        curr = updated.get(comp, "")
        if "collapse consecutive spaces" not in curr.lower():
            updated[comp] = curr + "\n- Collapse consecutive spaces."
        elif "remove duplicate punctuation" not in curr.lower():
            updated[comp] = curr + "\n- Remove duplicate punctuation."
        elif "trim leading/trailing whitespace" not in curr.lower():
            updated[comp] = curr + "\n- Trim leading/trailing whitespace."
    return updated


def _load_json_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if isinstance(parsed, dict):
        return dict(parsed)
    return {}


def _write_json_file(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def activate_prompt_policy(
    *,
    source_path: Path,
    activate_path: Path,
    config_path: Path,
    set_mode: str,
    update_config: bool,
    summary: dict[str, Any],
) -> dict[str, Any]:
    activate_path.parent.mkdir(parents=True, exist_ok=True)
    best_prompt = source_path.read_text(encoding="utf-8").strip()
    activate_path.write_text(best_prompt + "\n", encoding="utf-8")

    metadata_path = Path(str(activate_path) + ".meta.json")
    metadata = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "sourcePath": str(source_path),
        "activePath": str(activate_path),
        "setMode": set_mode,
        "runSummary": summary,
    }
    _write_json_file(metadata_path, metadata)

    config_updated = False
    if update_config:
        config_data = _load_json_file(config_path)
        config_data["promptRefinerPolicyPath"] = str(activate_path)
        if set_mode != "keep":
            config_data["promptRefinerMode"] = set_mode
        _write_json_file(config_path, config_data)
        config_updated = True

    return {
        "applied": True,
        "activePath": str(activate_path),
        "metadataPath": str(metadata_path),
        "configPath": str(config_path),
        "configUpdated": config_updated,
        "setMode": set_mode,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run GEPA optimization for prompt-refiner policy using exported GEPA JSONL datasets."
    )
    parser.add_argument("--train", type=Path, default=_default_train_path(), help="train JSONL path")
    parser.add_argument("--val", type=Path, default=_default_val_path(), help="val JSONL path")
    parser.add_argument("--subset-train", type=int, default=None, help="optional train subset size")
    parser.add_argument("--subset-val", type=int, default=None, help="optional val subset size")
    parser.add_argument(
        "--changed-only",
        action="store_true",
        help="use only rows where meta.changed=true from exported GEPA JSONL",
    )
    parser.add_argument("--max-metric-calls", type=int, default=80, help="GEPA budget")
    parser.add_argument("--run-dir", type=Path, default=_default_run_dir(), help="GEPA run dir")
    parser.add_argument(
        "--fresh",
        action="store_true",
        help="delete existing run-dir before starting (disables GEPA resume behavior)",
    )
    parser.add_argument("--seed", type=int, default=0, help="random seed")
    parser.add_argument(
        "--seed-prompt",
        type=str,
        default=_default_seed_prompt(),
        help="initial system prompt text",
    )
    parser.add_argument(
        "--task-lm",
        type=str,
        default=os.getenv("MUDCODE_GEPA_TASK_LM", "openai/gpt-4.1-mini"),
        help="task LM model id (used when not --smoke)",
    )
    parser.add_argument(
        "--reflection-lm",
        type=str,
        default=os.getenv("MUDCODE_GEPA_REFLECTION_LM", "openai/gpt-5-mini"),
        help="reflection LM model id (used when not --smoke)",
    )
    parser.add_argument(
        "--smoke",
        action="store_true",
        help="run without external LLM APIs using local heuristic task model + deterministic proposer",
    )
    parser.add_argument(
        "--progress",
        action="store_true",
        help="enable GEPA tqdm progress bar (requires tqdm in the Python env)",
    )
    parser.add_argument(
        "--activate",
        action="store_true",
        help="activate best prompt into policy file and update ~/.mudcode/config.json",
    )
    parser.add_argument(
        "--activate-path",
        type=Path,
        default=_default_activate_path(),
        help="target prompt policy path used by daemon runtime",
    )
    parser.add_argument(
        "--activate-config-path",
        type=Path,
        default=_default_activate_config_path(),
        help="mudcode config.json path to update promptRefinerPolicyPath",
    )
    parser.add_argument(
        "--activate-set-mode",
        choices=["keep", "off", "shadow", "enforce"],
        default="keep",
        help='when activating, optionally force promptRefinerMode ("keep" preserves existing mode)',
    )
    parser.add_argument(
        "--no-activate-config",
        action="store_true",
        help="activate policy file only (skip config.json update)",
    )
    parser.add_argument(
        "--activate-min-improvement",
        type=float,
        default=_default_activate_min_improvement(),
        help="minimum (best-base) val score improvement required for activation",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if gepa is None:
        raise RuntimeError("gepa package is required (try: uvx --from gepa==0.1.0 python scripts/prompt/prompt-refiner-gepa-optimize.py)")

    train_rows = load_jsonl(args.train, args.subset_train, changed_only=args.changed_only)
    val_rows = load_jsonl(args.val, args.subset_val, changed_only=args.changed_only)
    if args.changed_only and not val_rows and len(train_rows) >= 2:
        fallback_val_count = max(1, min(4, len(train_rows) // 4))
        val_rows = train_rows[-fallback_val_count:]
        train_rows = train_rows[:-fallback_val_count]
    if not train_rows:
        raise RuntimeError("empty train dataset after filtering")
    if not val_rows:
        raise RuntimeError("empty val dataset after filtering")

    trainset = to_gepa_dataset(train_rows)
    valset = to_gepa_dataset(val_rows)
    evaluator = PromptRefinerEvaluator()

    if args.fresh and args.run_dir.exists():
        shutil.rmtree(args.run_dir)
    args.run_dir.mkdir(parents=True, exist_ok=True)
    run_meta_path = args.run_dir / "mudcode-gepa-run-meta.json"
    run_meta = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "trainPath": str(args.train),
        "valPath": str(args.val),
        "trainCount": len(trainset),
        "valCount": len(valset),
        "maxMetricCalls": args.max_metric_calls,
        "changedOnly": args.changed_only,
        "smoke": args.smoke,
        "taskLM": args.task_lm,
        "reflectionLM": args.reflection_lm,
        "seed": args.seed,
    }
    try:
        run_meta["gepaVersion"] = importlib_metadata.version("gepa")
    except Exception:
        run_meta["gepaVersion"] = None
    run_meta_path.write_text(json.dumps(run_meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    seed_candidate = {"system_prompt": args.seed_prompt}
    optimize_kwargs: dict[str, Any] = dict(
        seed_candidate=seed_candidate,
        trainset=trainset,
        valset=valset,
        evaluator=evaluator,
        max_metric_calls=args.max_metric_calls,
        run_dir=str(args.run_dir),
        reflection_minibatch_size=min(4, len(trainset)),
        display_progress_bar=args.progress,
        seed=args.seed,
        raise_on_exception=False,
    )

    if args.smoke:
        optimize_kwargs["task_lm"] = heuristic_task_model
        optimize_kwargs["custom_candidate_proposer"] = heuristic_candidate_proposer
        optimize_kwargs["reflection_lm"] = None
    else:
        optimize_kwargs["task_lm"] = args.task_lm
        optimize_kwargs["reflection_lm"] = args.reflection_lm

    result = gepa.optimize(**optimize_kwargs)

    best_candidate = result.best_candidate
    if isinstance(best_candidate, dict):
        best_prompt = str(best_candidate.get("system_prompt", ""))
    else:
        best_prompt = str(best_candidate)
    best_path = args.run_dir / "best-system-prompt.txt"
    best_path.write_text(best_prompt + "\n", encoding="utf-8")

    best_idx = result.best_idx
    best_val_score = float(result.val_aggregate_scores[best_idx])
    base_val_score = float(result.val_aggregate_scores[0]) if len(result.val_aggregate_scores) > 0 else best_val_score
    val_improvement = best_val_score - base_val_score

    summary = {
        "bestValScore": best_val_score,
        "baseValScore": base_val_score,
        "valImprovement": val_improvement,
        "activateMinImprovement": args.activate_min_improvement,
        "bestIdx": best_idx,
        "bestPromptPath": str(best_path),
        "runDir": str(args.run_dir),
        "smoke": args.smoke,
    }

    if args.activate:
        if val_improvement + 1e-9 >= args.activate_min_improvement:
            summary["activation"] = activate_prompt_policy(
                source_path=best_path,
                activate_path=args.activate_path,
                config_path=args.activate_config_path,
                set_mode=args.activate_set_mode,
                update_config=not args.no_activate_config,
                summary=summary,
            )
        else:
            summary["activation"] = {
                "applied": False,
                "reason": "min_improvement_not_met",
                "required": args.activate_min_improvement,
                "actual": val_improvement,
            }

    (args.run_dir / "mudcode-gepa-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print("GEPA optimization complete")
    print(f"- smoke: {args.smoke}")
    print(f"- best val score: {best_val_score}")
    print(f"- base val score: {base_val_score}")
    print(f"- val improvement: {val_improvement}")
    print(f"- activate min improvement: {args.activate_min_improvement}")
    print(f"- best prompt path: {best_path}")
    print(f"- run dir: {args.run_dir}")
    if args.activate:
        activation = summary.get("activation", {})
        if isinstance(activation, dict) and activation.get("applied"):
            print(f"- activated policy path: {activation.get('activePath')}")
            print(f"- updated config path: {activation.get('configPath')}")
        else:
            print(f"- activation skipped: {activation}")


if __name__ == "__main__":
    main()
