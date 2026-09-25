#!/usr/bin/env bash
# Finds the CI run (.github/workflows/ci.yml) for a commit, waits for it to finish, downloads its
# e2e-screenshots artifact and lists the PNG files in it.
#
# Usage:
#   fetch-e2e-screenshots.sh [--branch <name>] [--sha <commit>] [--dispatch] [--run-id <id>]
#                            [--out-root <dir>] [--find-timeout <seconds>]
#
#   --branch        Branch whose runs are searched. Default: the current git branch.
#   --sha           Commit whose run is picked. Default: HEAD. Push it first.
#   --dispatch      Start a new run with `gh workflow run ci.yml --ref <branch>` (for a branch without a
#                   pull request) and pick that run instead of matching --sha.
#   --run-id        Use this run and skip the search.
#   --out-root      The artifact goes to <out-root>/e2e-<run id>-<run attempt>. Default: <repository root>/tmp.
#   --find-timeout  How long to keep looking for a run that has not been created yet. Default: 120.
#
# Output on stdout, one KEY=value per line:
#   RUN_ID, RUN_ATTEMPT, RUN_URL, CONCLUSION, FAILED_LOG_COMMAND=<command> when the run did not succeed,
#   then DIR and SCREENSHOT=<path> for each PNG once the artifact is downloaded.
# Progress goes to stderr.
#
# Exit codes:
#   0  the run succeeded and its artifact is downloaded
#   1  the run finished without success; its artifact is downloaded and the screenshots are listed
#   2  invalid arguments
#   3  no run was found, or a gh / git command failed
#   4  the run finished, but its artifact could not be downloaded (missing, expired, or a network error);
#      nothing is listed and the next call tries the download again
#
# Idempotent: a run attempt whose artifact directory exists is not downloaded again; the directory is created
# only after a complete download.
# Requires gh (authenticated), git and jq.
set -euo pipefail

readonly workflow_file="ci.yml"
readonly artifact_name="e2e-screenshots"
# 10 seconds keeps the number of API calls low while a just-pushed run usually appears within one or two polls.
readonly poll_interval_seconds=10

# Prints the header comment of this file as the usage text.
usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//' >&2
}

# Exits with the invalid-arguments code after printing the message $1 and the usage.
fail_usage() {
  echo "error: $1" >&2
  usage
  exit 2
}

# Exits with the run-not-found / gh-failure code after printing the message $1.
fail_run() {
  echo "error: $1" >&2
  exit 3
}

branch=""
sha=""
dispatch=false
run_id=""
out_root=""
# 120 seconds covers the delay between a push and GitHub creating the pull_request run, including queueing.
find_timeout=120

while [ $# -gt 0 ]; do
  case "$1" in
    --branch | --sha | --run-id | --out-root | --find-timeout)
      [ $# -ge 2 ] || fail_usage "$1 needs a value"
      case "$1" in
        --branch) branch="$2" ;;
        --sha) sha="$2" ;;
        --run-id) run_id="$2" ;;
        --out-root) out_root="$2" ;;
        --find-timeout) find_timeout="$2" ;;
      esac
      shift 2
      ;;
    --dispatch)
      dispatch=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail_usage "unknown argument: $1"
      ;;
  esac
done

[[ -z "$run_id" || "$run_id" =~ ^[0-9]+$ ]] || fail_usage "--run-id must be a number: $run_id"
[[ "$find_timeout" =~ ^[0-9]+$ ]] || fail_usage "--find-timeout must be a non-negative integer: $find_timeout"
if [ -n "$run_id" ] && { [ "$dispatch" = true ] || [ -n "$sha" ]; }; then
  fail_usage "--run-id cannot be combined with --dispatch or --sha"
fi
if [ "$dispatch" = true ] && [ -n "$sha" ]; then
  fail_usage "--dispatch picks the new run, so it cannot be combined with --sha"
fi

if [ -z "$out_root" ]; then
  out_root="$(git rev-parse --show-toplevel)/tmp" || fail_run "not in a git repository; pass --out-root"
fi

# Prints the run id matching the jq filter $1 among the newest runs of the branch, or nothing.
find_run_id() {
  gh run list --workflow "$workflow_file" --branch "$branch" --limit 20 \
    --json databaseId,headSha,event,createdAt,url |
    jq -r "[.[] | select($1)] | first | .databaseId // empty"
}

if [ -z "$run_id" ]; then
  if [ -z "$branch" ]; then
    branch="$(git branch --show-current)" || fail_run "cannot read the current branch; pass --branch"
    [ -n "$branch" ] || fail_run "HEAD is detached; pass --branch"
  fi

  if [ "$dispatch" = true ]; then
    # Run ids increase over time, so any dispatch run newer than the current newest one is the run started here.
    newest_before="$(gh run list --workflow "$workflow_file" --branch "$branch" --event workflow_dispatch --limit 1 \
      --json databaseId | jq -r 'first | .databaseId // 0')" || fail_run "gh run list failed"
    gh workflow run "$workflow_file" --ref "$branch" >&2 || fail_run "gh workflow run failed"
    filter=".event == \"workflow_dispatch\" and .databaseId > $newest_before"
  else
    if [ -z "$sha" ]; then
      sha="$(git rev-parse HEAD)" || fail_run "cannot read HEAD; pass --sha"
    fi
    filter=".headSha == \"$sha\""
  fi

  waited=0
  while :; do
    run_id="$(find_run_id "$filter")" || fail_run "gh run list failed"
    [ -z "$run_id" ] || break
    if [ "$waited" -ge "$find_timeout" ]; then
      if [ "$dispatch" = true ]; then
        fail_run "no new $workflow_file run appeared on $branch within ${find_timeout}s after dispatching"
      fi
      fail_run "no $workflow_file run found for $sha on $branch; push the commit and open a pull request, or rerun with --dispatch"
    fi
    echo "waiting for the $workflow_file run to appear..." >&2
    sleep "$poll_interval_seconds"
    waited=$((waited + poll_interval_seconds))
  done
fi

echo "watching run $run_id..." >&2
gh run watch "$run_id" --interval 30 >&2 || fail_run "gh run watch failed for run $run_id"

run_json="$(gh run view "$run_id" --json conclusion,url,attempt)" || fail_run "gh run view failed for run $run_id"
conclusion="$(jq -r '.conclusion' <<<"$run_json")"
run_url="$(jq -r '.url' <<<"$run_json")"
run_attempt="$(jq -r '.attempt' <<<"$run_json")"

echo "RUN_ID=$run_id"
echo "RUN_ATTEMPT=$run_attempt"
echo "RUN_URL=$run_url"
echo "CONCLUSION=$conclusion"
if [ "$conclusion" != "success" ]; then
  echo "FAILED_LOG_COMMAND=gh run view $run_id --log-failed"
fi

# A re-run keeps the run id and replaces the artifact, so the directory is per attempt.
# The artifact is downloaded into a staging directory and moved into place only after a complete download,
# so an existing $dir always holds a complete artifact and a failed download is retried on the next call.
dir="$out_root/e2e-$run_id-$run_attempt"
if [ -d "$dir" ]; then
  echo "$dir already has the artifact; skipping the download" >&2
else
  partial_dir="$dir.partial"
  rm -rf "$partial_dir"
  mkdir -p "$partial_dir"
  if ! gh run download "$run_id" -n "$artifact_name" -D "$partial_dir" >&2; then
    rm -rf "$partial_dir"
    echo "error: could not download the $artifact_name artifact of run $run_id (missing, expired, or a network error)" >&2
    exit 4
  fi
  mv "$partial_dir" "$dir"
fi

echo "DIR=$dir"
find "$dir" -type f -name '*.png' | sort | sed 's/^/SCREENSHOT=/'

[ "$conclusion" = "success" ] || exit 1
