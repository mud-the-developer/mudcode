use anyhow::{Context, Result, bail};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const DEFAULT_PREFIX: &str = "prompt-refiner-gepa";
const DEFAULT_VAL_RATIO: f64 = 0.1;
const DEFAULT_DEDUPE_KEY: DedupeKey = DedupeKey::Baseline;
const DEFAULT_SPLIT_KEY: SplitKey = SplitKey::Sample;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DedupeKey {
    Baseline,
    BaselineCandidate,
}

impl DedupeKey {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "baseline" => Ok(Self::Baseline),
            "baseline-candidate" => Ok(Self::BaselineCandidate),
            other => bail!(
                "invalid --dedupe-key: {other} (expected: baseline|baseline-candidate)"
            ),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Baseline => "baseline",
            Self::BaselineCandidate => "baseline-candidate",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SplitKey {
    Sample,
    Baseline,
}

impl SplitKey {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "sample" => Ok(Self::Sample),
            "baseline" => Ok(Self::Baseline),
            other => bail!("invalid --split-key: {other} (expected: sample|baseline)"),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Sample => "sample",
            Self::Baseline => "baseline",
        }
    }
}

#[derive(Debug, Clone)]
struct CliArgs {
    input: PathBuf,
    out_dir: PathBuf,
    prefix: String,
    val_ratio: f64,
    dedupe_key: DedupeKey,
    split_key: SplitKey,
    include_unchanged: bool,
    help: bool,
}

#[derive(Debug, Clone)]
struct ParsedEntry {
    ts: Option<String>,
    mode: Option<String>,
    changed: bool,
    operations: Vec<String>,
    baseline: String,
    candidate: String,
    baseline_hash: String,
    candidate_hash: String,
    baseline_len: usize,
    candidate_len: usize,
}

#[derive(Debug, Clone, Serialize)]
struct SampleMeta {
    changed: bool,
    operations: Vec<String>,
    mode: String,
    #[serde(rename = "sourceTs", skip_serializing_if = "Option::is_none")]
    source_ts: Option<String>,
    #[serde(rename = "baselineHash")]
    baseline_hash: String,
    #[serde(rename = "candidateHash")]
    candidate_hash: String,
    #[serde(rename = "baselineLen")]
    baseline_len: usize,
    #[serde(rename = "candidateLen")]
    candidate_len: usize,
}

#[derive(Debug, Clone, Serialize)]
struct SampleRow {
    id: String,
    prompt: String,
    target: String,
    meta: SampleMeta,
}

#[derive(Debug, Clone, Serialize)]
struct OutputMeta {
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "inputPath")]
    input_path: String,
    #[serde(rename = "includeUnchanged")]
    include_unchanged: bool,
    #[serde(rename = "dedupeKey")]
    dedupe_key: String,
    #[serde(rename = "splitKey")]
    split_key: String,
    #[serde(rename = "valRatio")]
    val_ratio: f64,
    #[serde(rename = "rawLineCount")]
    raw_line_count: usize,
    #[serde(rename = "parseErrors")]
    parse_errors: usize,
    #[serde(rename = "filteredUnchanged")]
    filtered_unchanged: usize,
    #[serde(rename = "dedupedCount")]
    deduped_count: usize,
    #[serde(rename = "trainCount")]
    train_count: usize,
    #[serde(rename = "valCount")]
    val_count: usize,
    output: Value,
}

fn usage() {
    println!(
        "\
Usage:
  cargo run --manifest-path mudcode-rs/Cargo.toml --bin prompt_refiner_shadow_to_gepa --release -- [options]

Options:
  --input <path>       Shadow JSONL path
  --out-dir <dir>      Output directory
  --prefix <name>      Output filename prefix
  --val-ratio <0..1>   Validation split ratio (default: 0.1)
  --dedupe-key <key>   Dedupe strategy: baseline|baseline-candidate (default: baseline)
  --split-key <key>    Split strategy: sample|baseline (default: sample)
  --all                Include unchanged entries (default: changed-only)
  --help               Show help

Outputs:
  <out-dir>/{DEFAULT_PREFIX}-train.jsonl
  <out-dir>/{DEFAULT_PREFIX}-val.jsonl
  <out-dir>/{DEFAULT_PREFIX}-meta.json"
    );
}

fn parse_args() -> Result<CliArgs> {
    let home = env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let default_input = PathBuf::from(home)
        .join(".mudcode")
        .join("prompt-refiner-shadow.jsonl");
    let default_out_dir = env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".mudcode")
        .join("gepa");

    let mut args = CliArgs {
        input: env::var("MUDCODE_PROMPT_REFINER_LOG_PATH")
            .map(PathBuf::from)
            .unwrap_or(default_input),
        out_dir: env::var("MUDCODE_GEPA_OUT_DIR")
            .map(PathBuf::from)
            .unwrap_or(default_out_dir),
        prefix: env::var("MUDCODE_GEPA_PREFIX").unwrap_or_else(|_| DEFAULT_PREFIX.to_string()),
        val_ratio: DEFAULT_VAL_RATIO,
        dedupe_key: env::var("MUDCODE_GEPA_DEDUPE_KEY")
            .ok()
            .as_deref()
            .map(DedupeKey::parse)
            .transpose()?
            .unwrap_or(DEFAULT_DEDUPE_KEY),
        split_key: env::var("MUDCODE_GEPA_SPLIT_KEY")
            .ok()
            .as_deref()
            .map(SplitKey::parse)
            .transpose()?
            .unwrap_or(DEFAULT_SPLIT_KEY),
        include_unchanged: false,
        help: false,
    };

    let raw = env::args().skip(1).collect::<Vec<_>>();
    let mut i = 0usize;
    while i < raw.len() {
        let token = &raw[i];
        match token.as_str() {
            "--help" | "-h" => {
                args.help = true;
                i += 1;
            }
            "--all" => {
                args.include_unchanged = true;
                i += 1;
            }
            "--input" => {
                let next = raw.get(i + 1).context("missing value for --input")?;
                args.input = PathBuf::from(next);
                i += 2;
            }
            "--out-dir" => {
                let next = raw.get(i + 1).context("missing value for --out-dir")?;
                args.out_dir = PathBuf::from(next);
                i += 2;
            }
            "--prefix" => {
                let next = raw.get(i + 1).context("missing value for --prefix")?;
                args.prefix = next.clone();
                i += 2;
            }
            "--val-ratio" => {
                let next = raw.get(i + 1).context("missing value for --val-ratio")?;
                let parsed = next
                    .parse::<f64>()
                    .with_context(|| format!("invalid --val-ratio: {next}"))?;
                if !(0.0..=0.9).contains(&parsed) {
                    bail!("--val-ratio must be between 0.0 and 0.9");
                }
                args.val_ratio = parsed;
                i += 2;
            }
            "--dedupe-key" => {
                let next = raw.get(i + 1).context("missing value for --dedupe-key")?;
                args.dedupe_key = DedupeKey::parse(next)?;
                i += 2;
            }
            "--split-key" => {
                let next = raw.get(i + 1).context("missing value for --split-key")?;
                args.split_key = SplitKey::parse(next)?;
                i += 2;
            }
            other => {
                bail!("unknown argument: {other}");
            }
        }
    }

    if args.help {
        return Ok(args);
    }

    args.input = normalize_path(&args.input)?;
    args.out_dir = normalize_path(&args.out_dir)?;
    Ok(args)
}

fn normalize_path(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    Ok(env::current_dir()?.join(path))
}

fn hash_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn short_hash16(input: &str) -> String {
    hash_hex(input).chars().take(16).collect()
}

fn should_go_to_val(id: &str, val_ratio: f64) -> bool {
    if val_ratio <= 0.0 {
        return false;
    }
    let head = id.chars().take(8).collect::<String>();
    let Ok(raw) = u32::from_str_radix(&head, 16) else {
        return false;
    };
    let bucket = (raw as f64) / 4_294_967_295.0;
    bucket < val_ratio
}

fn split_partition_key<'a>(sample: &'a SampleRow, split_key: SplitKey) -> &'a str {
    match split_key {
        SplitKey::Sample => &sample.id,
        SplitKey::Baseline => &sample.meta.baseline_hash,
    }
}

fn parse_shadow_line(line: &str) -> Option<ParsedEntry> {
    let parsed: Value = serde_json::from_str(line).ok()?;
    let baseline = parsed.get("baseline")?.as_str()?.to_string();
    let candidate = parsed.get("candidate")?.as_str()?.to_string();
    if baseline.is_empty() || candidate.is_empty() {
        return None;
    }

    let ts = parsed
        .get("ts")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let mode = parsed
        .get("mode")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let changed = parsed
        .get("changed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let operations = parsed
        .get("operations")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|v| v.as_str().unwrap_or("").to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let baseline_hash = parsed
        .get("baselineHash")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| short_hash16(&baseline));
    let candidate_hash = parsed
        .get("candidateHash")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| short_hash16(&candidate));

    let baseline_len = parsed
        .get("baselineLen")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(baseline.len());
    let candidate_len = parsed
        .get("candidateLen")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(candidate.len());

    Some(ParsedEntry {
        ts,
        mode,
        changed,
        operations,
        baseline,
        candidate,
        baseline_hash,
        candidate_hash,
        baseline_len,
        candidate_len,
    })
}

fn compare_signal(a: &ParsedEntry, b: &ParsedEntry) -> Ordering {
    (a.changed as u8)
        .cmp(&(b.changed as u8))
        .then_with(|| (a.candidate != a.baseline).cmp(&(b.candidate != b.baseline)))
        .then_with(|| a.operations.len().cmp(&b.operations.len()))
        .then_with(|| a.ts.as_deref().unwrap_or("").cmp(b.ts.as_deref().unwrap_or("")))
        .then_with(|| a.candidate_hash.cmp(&b.candidate_hash))
}

fn dedupe_group_key(item: &ParsedEntry, dedupe_key: DedupeKey) -> String {
    match dedupe_key {
        DedupeKey::Baseline => item.baseline_hash.clone(),
        DedupeKey::BaselineCandidate => {
            format!("{}:{}", item.baseline_hash, item.candidate_hash)
        }
    }
}

fn insert_deduped(
    dedup: &mut BTreeMap<String, ParsedEntry>,
    parsed: ParsedEntry,
    dedupe_key: DedupeKey,
) {
    let key = dedupe_group_key(&parsed, dedupe_key);
    if let Some(existing) = dedup.get(&key) {
        if compare_signal(&parsed, existing).is_gt() {
            dedup.insert(key, parsed);
        }
    } else {
        dedup.insert(key, parsed);
    }
}

fn write_jsonl(path: &Path, rows: &[SampleRow]) -> Result<()> {
    let mut out = String::new();
    for row in rows {
        out.push_str(&serde_json::to_string(row)?);
        out.push('\n');
    }
    fs::write(path, out)?;
    Ok(())
}

fn main() -> Result<()> {
    let args = parse_args()?;
    if args.help {
        usage();
        return Ok(());
    }

    if !args.input.exists() {
        bail!("Shadow log not found: {}", args.input.display());
    }

    let raw = fs::read_to_string(&args.input)
        .with_context(|| format!("failed to read {}", args.input.display()))?;
    let lines = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();

    let mut parse_errors = 0usize;
    let mut filtered_unchanged = 0usize;
    let mut dedup = BTreeMap::<String, ParsedEntry>::new();

    for line in &lines {
        let Some(parsed) = parse_shadow_line(line) else {
            parse_errors += 1;
            continue;
        };
        if !args.include_unchanged && !parsed.changed {
            filtered_unchanged += 1;
            continue;
        }
        insert_deduped(&mut dedup, parsed, args.dedupe_key);
    }

    let samples = dedup
        .into_values()
        .map(|item| {
            let id = hash_hex(&format!("{}:{}", item.baseline_hash, item.candidate_hash))
                .chars()
                .take(24)
                .collect::<String>();
            SampleRow {
                id,
                prompt: item.baseline,
                target: item.candidate,
                meta: SampleMeta {
                    changed: item.changed,
                    operations: item.operations,
                    mode: item.mode.unwrap_or_else(|| "shadow".to_string()),
                    source_ts: item.ts,
                    baseline_hash: item.baseline_hash,
                    candidate_hash: item.candidate_hash,
                    baseline_len: item.baseline_len,
                    candidate_len: item.candidate_len,
                },
            }
        })
        .collect::<Vec<_>>();

    let mut train = Vec::<SampleRow>::new();
    let mut val = Vec::<SampleRow>::new();
    for sample in samples {
        if should_go_to_val(split_partition_key(&sample, args.split_key), args.val_ratio) {
            val.push(sample);
        } else {
            train.push(sample);
        }
    }

    fs::create_dir_all(&args.out_dir)
        .with_context(|| format!("failed to create {}", args.out_dir.display()))?;
    let train_path = args.out_dir.join(format!("{}-train.jsonl", args.prefix));
    let val_path = args.out_dir.join(format!("{}-val.jsonl", args.prefix));
    let meta_path = args.out_dir.join(format!("{}-meta.json", args.prefix));

    write_jsonl(&train_path, &train)?;
    write_jsonl(&val_path, &val)?;

    let meta = OutputMeta {
        created_at: chrono_like_now(),
        input_path: args.input.display().to_string(),
        include_unchanged: args.include_unchanged,
        dedupe_key: args.dedupe_key.as_str().to_string(),
        split_key: args.split_key.as_str().to_string(),
        val_ratio: args.val_ratio,
        raw_line_count: lines.len(),
        parse_errors,
        filtered_unchanged,
        deduped_count: train.len() + val.len(),
        train_count: train.len(),
        val_count: val.len(),
        output: json!({
            "trainPath": train_path.display().to_string(),
            "valPath": val_path.display().to_string(),
        }),
    };
    fs::write(
        &meta_path,
        format!("{}\n", serde_json::to_string_pretty(&meta)?),
    )?;

    println!("GEPA dataset export complete (Rust)");
    println!("- input: {}", args.input.display());
    println!("- raw lines: {}", lines.len());
    println!("- parse errors: {}", parse_errors);
    println!("- filtered unchanged: {}", filtered_unchanged);
    println!("- dedupe key: {}", args.dedupe_key.as_str());
    println!("- split key: {}", args.split_key.as_str());
    println!("- deduped samples: {}", train.len() + val.len());
    println!("- train: {} -> {}", train.len(), train_path.display());
    println!("- val: {} -> {}", val.len(), val_path.display());
    println!("- meta: {}", meta_path.display());
    Ok(())
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let dt = chrono_from_unix(now);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        dt.year, dt.month, dt.day, dt.hour, dt.min, dt.sec
    )
}

#[derive(Clone, Copy)]
struct DateTimeParts {
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    min: u32,
    sec: u32,
}

fn chrono_from_unix(mut ts: u64) -> DateTimeParts {
    let sec = (ts % 60) as u32;
    ts /= 60;
    let min = (ts % 60) as u32;
    ts /= 60;
    let hour = (ts % 24) as u32;
    ts /= 24;

    let z = ts as i64 + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    y += if m <= 2 { 1 } else { 0 };

    DateTimeParts {
        year: y as i32,
        month: m as u32,
        day: d as u32,
        hour,
        min,
        sec,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        DedupeKey, ParsedEntry, SampleMeta, SampleRow, SplitKey, compare_signal, hash_hex,
        insert_deduped, should_go_to_val, split_partition_key,
    };
    use std::cmp::Ordering;
    use std::collections::BTreeMap;

    fn parsed_entry(changed: bool, baseline: &str, candidate: &str, operations: &[&str], ts: Option<&str>) -> ParsedEntry {
        ParsedEntry {
            ts: ts.map(ToString::to_string),
            mode: Some("shadow".to_string()),
            changed,
            operations: operations.iter().map(|x| (*x).to_string()).collect(),
            baseline: baseline.to_string(),
            candidate: candidate.to_string(),
            baseline_hash: "basehash".to_string(),
            candidate_hash: format!("candhash-{}", candidate),
            baseline_len: baseline.len(),
            candidate_len: candidate.len(),
        }
    }

    fn sample_row(baseline_hash: &str, candidate_hash: &str) -> SampleRow {
        let id = hash_hex(&format!("{baseline_hash}:{candidate_hash}"))
            .chars()
            .take(24)
            .collect::<String>();
        SampleRow {
            id,
            prompt: "baseline".to_string(),
            target: "candidate".to_string(),
            meta: SampleMeta {
                changed: true,
                operations: vec![],
                mode: "shadow".to_string(),
                source_ts: None,
                baseline_hash: baseline_hash.to_string(),
                candidate_hash: candidate_hash.to_string(),
                baseline_len: 8,
                candidate_len: 9,
            },
        }
    }

    #[test]
    fn compare_signal_prefers_changed_over_unchanged() {
        let changed = parsed_entry(
            true,
            "hello   world",
            "hello world",
            &["collapse_consecutive_spaces"],
            Some("2026-03-03T10:00:00Z"),
        );
        let unchanged = parsed_entry(false, "hello   world", "hello   world", &[], Some("2026-03-03T11:00:00Z"));
        assert_eq!(compare_signal(&changed, &unchanged), Ordering::Greater);
    }

    #[test]
    fn compare_signal_prefers_richer_changed_sample() {
        let weaker = parsed_entry(true, "  hello   world!!  ", "hello   world!!", &[], Some("2026-03-03T10:00:00Z"));
        let richer = parsed_entry(
            true,
            "  hello   world!!  ",
            "hello world!",
            &["collapse_consecutive_spaces", "remove_duplicate_punctuation", "trim_outer_whitespace"],
            Some("2026-03-03T10:00:00Z"),
        );
        assert_eq!(compare_signal(&richer, &weaker), Ordering::Greater);
    }

    #[test]
    fn dedupe_baseline_candidate_keeps_changed_variants() {
        let mut dedup = BTreeMap::<String, ParsedEntry>::new();
        insert_deduped(
            &mut dedup,
            parsed_entry(
                true,
                "hello   world",
                "hello world",
                &["collapse_consecutive_spaces"],
                Some("2026-03-03T10:00:00Z"),
            ),
            DedupeKey::BaselineCandidate,
        );
        insert_deduped(
            &mut dedup,
            parsed_entry(
                true,
                "hello   world",
                "hello world!",
                &["collapse_consecutive_spaces", "remove_duplicate_punctuation"],
                Some("2026-03-03T10:01:00Z"),
            ),
            DedupeKey::BaselineCandidate,
        );
        assert_eq!(dedup.len(), 2);
    }

    #[test]
    fn dedupe_baseline_keeps_single_best_sample() {
        let mut dedup = BTreeMap::<String, ParsedEntry>::new();
        insert_deduped(
            &mut dedup,
            parsed_entry(
                true,
                "hello   world",
                "hello world",
                &["collapse_consecutive_spaces"],
                Some("2026-03-03T10:00:00Z"),
            ),
            DedupeKey::Baseline,
        );
        insert_deduped(
            &mut dedup,
            parsed_entry(
                true,
                "hello   world",
                "hello world!",
                &["collapse_consecutive_spaces", "remove_duplicate_punctuation"],
                Some("2026-03-03T10:01:00Z"),
            ),
            DedupeKey::Baseline,
        );
        assert_eq!(dedup.len(), 1);
        let only = dedup.values().next().expect("expected one deduped entry");
        assert_eq!(only.candidate, "hello world!");
    }

    #[test]
    fn split_key_baseline_prevents_variant_leakage() {
        let baseline_hash = "base-dup";
        let val_ratio = 0.5;
        let mut sample_val: Option<SampleRow> = None;
        let mut sample_train: Option<SampleRow> = None;

        for idx in 0..256 {
            let row = sample_row(baseline_hash, &format!("cand-{idx}"));
            if should_go_to_val(split_partition_key(&row, SplitKey::Sample), val_ratio) {
                if sample_val.is_none() {
                    sample_val = Some(row);
                }
            } else if sample_train.is_none() {
                sample_train = Some(row);
            }
            if sample_val.is_some() && sample_train.is_some() {
                break;
            }
        }

        let row_val = sample_val.expect("expected at least one sample-mode val variant");
        let row_train = sample_train.expect("expected at least one sample-mode train variant");
        let sample_partition = (
            should_go_to_val(split_partition_key(&row_val, SplitKey::Sample), val_ratio),
            should_go_to_val(split_partition_key(&row_train, SplitKey::Sample), val_ratio),
        );
        assert_ne!(sample_partition.0, sample_partition.1);

        let baseline_partition = (
            should_go_to_val(split_partition_key(&row_val, SplitKey::Baseline), val_ratio),
            should_go_to_val(split_partition_key(&row_train, SplitKey::Baseline), val_ratio),
        );
        assert_eq!(baseline_partition.0, baseline_partition.1);
    }

    #[test]
    fn split_key_partitioning_is_deterministic() {
        let row = sample_row("base-deterministic", "cand-deterministic");
        let first = should_go_to_val(split_partition_key(&row, SplitKey::Baseline), 0.37);
        let second = should_go_to_val(split_partition_key(&row, SplitKey::Baseline), 0.37);
        assert_eq!(first, second);
    }
}
