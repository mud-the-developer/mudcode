import importlib.util
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "prompt" / "prompt-refiner-gepa-optimize.py"
SPEC = importlib.util.spec_from_file_location("prompt_refiner_gepa_optimize", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"failed to load script module: {SCRIPT_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class PromptRefinerGepaOptimizeTests(unittest.TestCase):
    def test_evaluator_requires_stricter_exactness(self) -> None:
        evaluator = MODULE.PromptRefinerEvaluator()
        data = {"answer": "hello world"}

        exact = evaluator(data, "hello world")
        exact_with_whitespace_noise = evaluator(data, "  hello   world  ")
        substring_with_junk = evaluator(data, "hello world -- plus unrelated text")

        self.assertEqual(exact.score, 1.0)
        self.assertLess(exact_with_whitespace_noise.score, 1.0)
        self.assertGreater(exact_with_whitespace_noise.score, 0.9)
        self.assertLess(substring_with_junk.score, 0.95)
        self.assertGreater(substring_with_junk.score, 0.0)

    def test_loader_preserves_prompt_target_whitespace(self) -> None:
        with TemporaryDirectory() as temp_dir:
            dataset_path = Path(temp_dir) / "dataset.jsonl"
            rows = [
                {
                    "id": "row-a",
                    "prompt": "  keep leading and trailing  ",
                    "target": "\nline target \n",
                    "meta": {"changed": True},
                },
                {
                    "id": "row-b",
                    "prompt": "\tstill meaningful\t",
                    "target": " value ",
                    "meta": {"changed": False},
                },
                {
                    "id": "row-empty",
                    "prompt": "",
                    "target": "should be dropped",
                    "meta": {"changed": True},
                },
            ]
            raw = "\n\n" + "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n\n"
            dataset_path.write_text(raw, encoding="utf-8")

            loaded = MODULE.load_jsonl(dataset_path)
            self.assertEqual(len(loaded), 2)
            self.assertEqual(loaded[0].sample_id, "row-a")
            self.assertEqual(loaded[0].prompt, "  keep leading and trailing  ")
            self.assertEqual(loaded[0].target, "\nline target \n")
            self.assertEqual(loaded[1].sample_id, "row-b")
            self.assertEqual(loaded[1].prompt, "\tstill meaningful\t")
            self.assertEqual(loaded[1].target, " value ")

            changed_only = MODULE.load_jsonl(dataset_path, changed_only=True)
            self.assertEqual([row.sample_id for row in changed_only], ["row-a"])


if __name__ == "__main__":
    unittest.main()
