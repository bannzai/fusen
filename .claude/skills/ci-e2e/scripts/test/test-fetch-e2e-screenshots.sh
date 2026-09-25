#!/usr/bin/env bash
# Tests fetch-e2e-screenshots.sh without GitHub: a stub `gh` placed first on PATH answers from the
# GH_STUB_* variables below and records every call in $GH_STUB_LOG.
#
#   GH_STUB_RUN_LIST                 JSON returned by `gh run list` (default: [])
#   GH_STUB_RUN_LIST_AFTER_DISPATCH  JSON returned by `gh run list` once `gh workflow run` was called (default: GH_STUB_RUN_LIST)
#   GH_STUB_CONCLUSION               conclusion returned by `gh run view` (default: success)
#   GH_STUB_ATTEMPT                  run attempt returned by `gh run view` (default: 1)
#   GH_STUB_WATCH_FAILURES           number of first `gh run watch` calls that fail like a just-created run (default: 0)
#   GH_STUB_ARTIFACTS                JSON returned by `gh api .../runs/<id>/artifacts` (default: one e2e-screenshots artifact, id 1)
#   GH_STUB_NO_ARTIFACT              when set, the run has no artifacts
#   GH_STUB_BROKEN_ZIP               when set, `gh api .../artifacts/<id>/zip` writes a partial download and fails
set -euo pipefail

script="$(cd "$(dirname "$0")/.." && pwd)/fetch-e2e-screenshots.sh"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

mkdir -p "$work_dir/bin"
cat >"$work_dir/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "gh $*" >>"$GH_STUB_LOG"
if [ "$1" = "api" ]; then
  case "$2" in
    */actions/runs/*/artifacts*)
      if [ -n "${GH_STUB_NO_ARTIFACT:-}" ]; then
        echo '{"artifacts": []}'
      else
        # A run that was not re-run has exactly one e2e-screenshots artifact.
        default_artifacts='{"artifacts": [{"id": 1, "name": "e2e-screenshots", "created_at": "2026-09-25T01:00:00Z", "expired": false}]}'
        echo "${GH_STUB_ARTIFACTS:-$default_artifacts}"
      fi
      ;;
    */actions/artifacts/*/zip)
      [ -z "${GH_STUB_BROKEN_ZIP:-}" ] || { printf 'PK partial'; exit 1; }
      zip_root="$(mktemp -d)"
      mkdir -p "$zip_root/activation-Fusen-activates"
      : >"$zip_root/activation-Fusen-activates/activation.png"
      (cd "$zip_root" && zip -q -r - .)
      ;;
    *) echo "unexpected gh api call: $*" >&2; exit 99 ;;
  esac
  exit 0
fi
case "$1 $2" in
  "run list")
    if grep -qF "gh workflow run" "$GH_STUB_LOG"; then
      echo "${GH_STUB_RUN_LIST_AFTER_DISPATCH:-${GH_STUB_RUN_LIST:-[]}}"
    else
      echo "${GH_STUB_RUN_LIST:-[]}"
    fi
    ;;
  "run watch")
    if [ "$(grep -c "gh run watch" "$GH_STUB_LOG")" -le "${GH_STUB_WATCH_FAILURES:-0}" ]; then
      echo "failed to get jobs: HTTP 404: Not Found" >&2
      exit 1
    fi
    echo "run completed"
    ;;
  "run view") printf '{"conclusion":"%s","url":"https://github.com/o/r/actions/runs/%s","attempt":%s}\n' "${GH_STUB_CONCLUSION:-success}" "$3" "${GH_STUB_ATTEMPT:-1}" ;;
  "workflow run") echo "Created workflow_dispatch event" ;;
  *) echo "unexpected gh call: $*" >&2; exit 99 ;;
esac
STUB
chmod +x "$work_dir/bin/gh"

export PATH="$work_dir/bin:$PATH"
export GH_STUB_LOG="$work_dir/gh.log"

failures=0
out_root=""

# Runs the script with the given arguments in a fresh output root and captures stdout, stderr and the exit code.
run_script() {
  out_root="$(mktemp -d "$work_dir/out.XXXX")"
  : >"$GH_STUB_LOG"
  set +e
  bash "$script" --out-root "$out_root" "$@" >"$work_dir/stdout" 2>"$work_dir/stderr"
  status=$?
  set -e
}

# Runs the script again with the same output root as the previous run_script call.
rerun_script() {
  : >"$GH_STUB_LOG"
  set +e
  bash "$script" --out-root "$out_root" "$@" >"$work_dir/stdout" 2>"$work_dir/stderr"
  status=$?
  set -e
}

# Reports the check named $1 as PASS when the command in the remaining arguments succeeds,
# otherwise as FAIL with the captured output of the last script run.
check() {
  local name="$1"
  shift
  if "$@"; then
    echo "PASS: $name"
  else
    echo "FAIL: $name"
    echo "  exit: $status"
    sed 's/^/  stdout: /' "$work_dir/stdout"
    sed 's/^/  stderr: /' "$work_dir/stderr"
    failures=$((failures + 1))
  fi
}

# Succeeds when the last script run exited with $1.
exit_is() { [ "$status" -eq "$1" ]; }
# Succeeds when the last script run printed the line $1 on stdout.
stdout_has() { grep -qxF -- "$1" "$work_dir/stdout"; }
# Succeeds when the last script run printed $1 somewhere on stderr.
stderr_has() { grep -qF -- "$1" "$work_dir/stderr"; }
# Succeeds when a gh call of the last script run contains $1 (each call is logged as "gh <args>").
gh_called() { grep -qF -- "$1" "$GH_STUB_LOG"; }

runs='[
  {"databaseId": 300, "headSha": "cccccccccccccccccccccccccccccccccccccccc", "event": "pull_request", "createdAt": "2026-09-25T03:00:00Z", "url": "u300"},
  {"databaseId": 200, "headSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "event": "pull_request", "createdAt": "2026-09-25T02:00:00Z", "url": "u200"},
  {"databaseId": 100, "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "event": "workflow_dispatch", "createdAt": "2026-09-25T01:00:00Z", "url": "u100"}
]'

# Argument validation
run_script --unknown
check "unknown argument exits 2" exit_is 2
check "unknown argument prints usage" stderr_has "Usage:"

run_script --run-id abc
check "non-numeric --run-id exits 2" exit_is 2

run_script --find-timeout -1
check "negative --find-timeout exits 2" exit_is 2

run_script --branch
check "option without a value exits 2" exit_is 2

run_script --run-id 1 --dispatch
check "--run-id with --dispatch exits 2" exit_is 2

run_script --dispatch --sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --branch b
check "--dispatch with --sha exits 2" exit_is 2

run_script --help
check "--help exits 0" exit_is 0

# Run lookup
GH_STUB_RUN_LIST='[]' run_script --branch b --sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --find-timeout 0
check "no run exits 3" exit_is 3
check "no run explains how to start one" stderr_has "no ci.yml run found for aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa on b"

run_script --branch b --sha main --find-timeout 0
check "non-SHA --sha exits 2" exit_is 2

run_script --branch b --sha abc123 --find-timeout 0
check "--sha shorter than 7 characters exits 2" exit_is 2

GH_STUB_RUN_LIST="$runs" run_script --branch b --sha BBBBBBB --find-timeout 0
check "abbreviated uppercase --sha succeeds" exit_is 0
check "abbreviated --sha picks the run by prefix" stdout_has "RUN_ID=200"

GH_STUB_RUN_LIST="$runs" run_script --branch b --sha bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --find-timeout 0
check "run matching --sha succeeds" exit_is 0
check "run matching --sha is picked" stdout_has "RUN_ID=200"
check "run URL is printed" stdout_has "RUN_URL=https://github.com/o/r/actions/runs/200"
check "conclusion is printed" stdout_has "CONCLUSION=success"
check "screenshot is listed" stdout_has "SCREENSHOT=$out_root/e2e-200-1/activation-Fusen-activates/activation.png"
check "artifact of the run is looked up" gh_called "actions/runs/200/artifacts"
check "artifact is downloaded by id" gh_called "actions/artifacts/1/zip"

GH_STUB_RUN_LIST="$runs" rerun_script --branch b --sha bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --find-timeout 0
check "second run succeeds" exit_is 0
check "second run does not download again" bash -c "! grep -qF 'artifacts' '$GH_STUB_LOG'"
check "second run still lists the screenshot" stdout_has "SCREENSHOT=$out_root/e2e-200-1/activation-Fusen-activates/activation.png"

# A re-run leaves the first attempt's artifact next to the new one with the same name; the newest one is used.
rerun_artifacts='{"artifacts": [
  {"id": 1, "name": "e2e-screenshots", "created_at": "2026-09-25T01:00:00Z", "expired": false},
  {"id": 3, "name": "fusen-vsix", "created_at": "2026-09-25T03:00:00Z", "expired": false},
  {"id": 2, "name": "e2e-screenshots", "created_at": "2026-09-25T02:00:00Z", "expired": false}
]}'
GH_STUB_RUN_LIST="$runs" GH_STUB_ATTEMPT=2 GH_STUB_ARTIFACTS="$rerun_artifacts" \
  rerun_script --branch b --sha bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --find-timeout 0
check "re-run attempt succeeds" exit_is 0
check "re-run attempt is printed" stdout_has "RUN_ATTEMPT=2"
check "re-run attempt downloads the newest artifact" gh_called "actions/artifacts/2/zip"
check "re-run attempt does not download the first attempt's artifact" bash -c "! grep -qF 'actions/artifacts/1/zip' '$GH_STUB_LOG'"
check "re-run attempt lists its own screenshot" stdout_has "SCREENSHOT=$out_root/e2e-200-2/activation-Fusen-activates/activation.png"
check "re-run attempt does not list the previous attempt" bash -c "! grep -qF 'e2e-200-1' '$work_dir/stdout'"

run_script --run-id 42
check "--run-id succeeds" exit_is 0
check "--run-id skips the search" bash -c "! grep -qF 'run list' '$GH_STUB_LOG'"
check "--run-id is used" stdout_has "RUN_ID=42"

# Dispatch: the dispatch run that existed before dispatching (100) must not be picked.
dispatch_runs='[{"databaseId": 100, "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "event": "workflow_dispatch", "createdAt": "2026-09-25T01:00:00Z", "url": "u100"}]'
runs_after_dispatch='[
  {"databaseId": 400, "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "event": "workflow_dispatch", "createdAt": "2026-09-25T04:00:00Z", "url": "u400"},
  {"databaseId": 100, "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "event": "workflow_dispatch", "createdAt": "2026-09-25T01:00:00Z", "url": "u100"}
]'
GH_STUB_RUN_LIST="$dispatch_runs" GH_STUB_RUN_LIST_AFTER_DISPATCH="$runs_after_dispatch" \
  run_script --branch b --dispatch --find-timeout 0
check "dispatch succeeds" exit_is 0
check "dispatch calls gh workflow run" gh_called "gh workflow run ci.yml --ref b"
check "dispatch picks the new run" stdout_has "RUN_ID=400"

GH_STUB_RUN_LIST="$dispatch_runs" run_script --branch b --dispatch --find-timeout 0
check "dispatch without a new run exits 3" exit_is 3
check "dispatch explains the timeout" stderr_has "no new ci.yml run appeared on b"

# Watching a just-created run
GH_STUB_WATCH_FAILURES=1 run_script --run-id 50
check "watch is retried after a failure" exit_is 0
check "watch retry is reported" stderr_has "gh run watch failed; retrying"
check "watch retry still lists the screenshot" stdout_has "SCREENSHOT=$out_root/e2e-50-1/activation-Fusen-activates/activation.png"

GH_STUB_WATCH_FAILURES=3 run_script --run-id 51
check "watch gives up after three failures" exit_is 3
check "watch failure is explained" stderr_has "gh run watch failed for run 51"

# Failed runs
GH_STUB_CONCLUSION=failure run_script --run-id 7
check "failed run exits 1" exit_is 1
check "failed run prints the log command" stdout_has "FAILED_LOG_COMMAND=gh run view 7 --log-failed"
check "failed run still lists screenshots" stdout_has "SCREENSHOT=$out_root/e2e-7-1/activation-Fusen-activates/activation.png"

# Download failures
GH_STUB_NO_ARTIFACT=1 run_script --run-id 8
check "failed download exits 4" exit_is 4
check "failed download explains the cause" stderr_has "could not download the e2e-screenshots artifact of run 8"
check "failed download still prints the run" stdout_has "RUN_ID=8"
check "failed download lists nothing" bash -c "! grep -q '^SCREENSHOT=' '$work_dir/stdout'"
check "failed download leaves no artifact directory" bash -c "[ ! -e '$out_root/e2e-8-1' ] && [ ! -e '$out_root/e2e-8-1.partial' ]"

rerun_script --run-id 8
check "download is retried after a failure" gh_called "actions/artifacts/1/zip"
check "retried download succeeds" exit_is 0
check "retried download lists the screenshot" stdout_has "SCREENSHOT=$out_root/e2e-8-1/activation-Fusen-activates/activation.png"

GH_STUB_BROKEN_ZIP=1 run_script --run-id 10
check "broken download exits 4" exit_is 4
check "broken download leaves nothing behind" bash -c "[ ! -e '$out_root/e2e-10-1' ] && [ ! -e '$out_root/e2e-10-1.partial' ] && [ ! -e '$out_root/e2e-10-1.partial.zip' ]"

GH_STUB_CONCLUSION=failure GH_STUB_NO_ARTIFACT=1 run_script --run-id 9
check "failed run without an artifact exits 4" exit_is 4
check "failed run without an artifact prints the log command" stdout_has "FAILED_LOG_COMMAND=gh run view 9 --log-failed"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
