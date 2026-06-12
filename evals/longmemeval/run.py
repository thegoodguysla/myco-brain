"""
CLI entry point for the LongMemEval benchmark.

    python -m evals.longmemeval.run [options]

Options:
    --examples   INT   Number of dataset examples to evaluate (default 200)
    --split      STR   HuggingFace dataset split (default "test")
    --subset     STR   Dataset subset (default "longmemeval_s"; use "longmemeval_m" for multi-doc)
    --no-purge         Keep eval workspace in DB after run (default: purge)
    --workspace  STR   Use a specific workspace ID (default: random)
    --dry-run          Load dataset and ingest only, skip search evaluation
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from collections import Counter

import typer
from dotenv import load_dotenv

# Load .env from repo root if present
_ROOT = Path(__file__).parent.parent.parent
for candidate in [_ROOT / ".env", _ROOT / ".env.local"]:
    if candidate.exists():
        load_dotenv(candidate)
        break

from .dataset import load_dataset
from .metrics import format_report

app = typer.Typer(add_completion=False)


@app.command()
def main(
    examples: int = typer.Option(200, "--examples", "-n", help="Number of examples to evaluate"),
    split: str = typer.Option("test", "--split", help="Dataset split"),
    subset: str = typer.Option("longmemeval_s", "--subset", help="Dataset subset (e.g. longmemeval_oracle)"),
    purge: bool = typer.Option(True, "--purge/--no-purge", help="Purge per-question workspaces after run"),
    qa: bool = typer.Option(True, "--qa/--no-qa", help="Run end-to-end QA accuracy (needs OPENAI_API_KEY)"),
    reader_model: str = typer.Option("", "--reader-model", help="LLM that answers from retrieved context"),
    judge_model: str = typer.Option("", "--judge-model", help="LLM that judges answer correctness"),
    shuffle: bool = typer.Option(False, "--shuffle/--no-shuffle", help="Seeded shuffle for a representative cross-category sample"),
    seed: int = typer.Option(0, "--seed", help="Shuffle seed (with --shuffle)"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Ingest only, skip search eval"),
) -> None:
    """Run the LongMemEval benchmark against Brain search."""

    if dry_run:
        dataset = load_dataset(
            split=split, max_examples=examples, subset=subset,
            shuffle=shuffle, seed=seed,
        )
        categories = Counter(ex.category for ex in dataset)
        typer.echo(
            "[dry-run] Dataset load ok\n"
            f"  examples: {len(dataset)}\n"
            f"  split: {split}\n"
            f"  subset: {subset}"
        )
        typer.echo("  categories:")
        for name, count in sorted(categories.items()):
            typer.echo(f"    - {name}: {count}")
        raise typer.Exit(code=0)

    if not (os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL")):
        typer.echo(
            "ERROR: DATABASE_URL or SUPABASE_DB_URL must be set.\n"
            "       Add it to .env or export it before running.",
            err=True,
        )
        raise typer.Exit(code=1)

    from .harness import run_eval
    from .qa import DEFAULT_JUDGE_MODEL, DEFAULT_READER_MODEL

    results, qa_result = asyncio.run(
        run_eval(
            max_examples=examples,
            dataset_split=split,
            dataset_subset=subset,
            purge_after=purge,
            qa=qa,
            reader_model=reader_model or DEFAULT_READER_MODEL,
            judge_model=judge_model or DEFAULT_JUDGE_MODEL,
            shuffle=shuffle,
            seed=seed,
        )
    )

    report = format_report(results, qa_result)
    typer.echo("\n" + report)


if __name__ == "__main__":
    app()
