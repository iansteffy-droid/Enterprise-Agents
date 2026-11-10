# shellcheck shell=bash
# Curl wrappers for the Paperclip API. Source this file, then call pc_api_init.
#
#   pc_api_init <base-url> <tmp-dir>   base URL (e.g. http://127.0.0.1:3200) and a scratch dir
#   pc_get    <path>                   prints the JSON response
#   pc_post   <path> <body-file>       request bodies always come from a file (-d @file)
#   pc_put    <path> <body-file>
#   pc_patch  <path> <body-file>
#   pc_body   <jq-args...>             runs `jq -n <args>` into a fresh body file, prints its path
#
# Every call fails (return 1) on a transport error or a non-2xx status, printing the
# method, path, status and the start of the response body to stderr.

PC_API=""
PC_TMP=""

pc_api_init() {
  PC_API="${1%/}"
  PC_TMP="${2:?pc_api_init needs a scratch dir}"
  mkdir -p "$PC_TMP"
}

pc_request() { # method path [body-file]
  local method="$1" path="$2" data="${3:-}" out code
  out="$(mktemp "$PC_TMP/resp.XXXXXX")" || return 1
  local args=(-sS --max-time 60 -X "$method" -o "$out" -w '%{http_code}')
  if [ -n "$data" ]; then
    [ -f "$data" ] || { echo "$method $path: body file missing: $data" >&2; return 1; }
    args+=(-H 'content-type: application/json' -d @"$data")
  fi
  code="$(curl "${args[@]}" "$PC_API$path")" || { echo "$method $path: request failed" >&2; return 1; }
  case "$code" in
    2??) cat "$out" ;;
    *) echo "$method $path: HTTP $code: $(head -c 2000 "$out")" >&2; return 1 ;;
  esac
}

pc_get() { pc_request GET "$1"; }
pc_post() { pc_request POST "$1" "${2:?pc_post needs a body file}"; }
pc_put() { pc_request PUT "$1" "${2:?pc_put needs a body file}"; }
pc_patch() { pc_request PATCH "$1" "${2:?pc_patch needs a body file}"; }

pc_body() {
  local f
  f="$(mktemp "$PC_TMP/body.XXXXXX")" || return 1
  jq -n "$@" > "$f" || { echo "pc_body: jq failed" >&2; return 1; }
  printf '%s\n' "$f"
}
