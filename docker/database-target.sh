#!/bin/sh

# Compare the runtime URI with an owner URI (migrate) or libpq's explicit
# connection coordinates (reconcile). Return 1 for another server, 2 for
# another database on the bundled server, and 3 for an ambiguous destination.
# Accept explicit single-host destinations that pg and libpq interpret alike.
kvitbit_compare_database_target() {
  KVITBIT_TARGET_OWNER_URL="$1" KVITBIT_TARGET_HOST="${2:-}" \
    KVITBIT_TARGET_PORT="${3:-}" KVITBIT_TARGET_DB="${4:-}" LC_ALL=C awk '
    function decode(value, database_path,    result, i, byte, hex, high, low) {
      hex = "0123456789abcdef"
      for (i = 1; i <= length(value); i++) {
        byte = substr(value, i, 1)
        if (byte == "%") {
          high = index(hex, tolower(substr(value, i + 1, 1))) - 1
          low = index(hex, tolower(substr(value, i + 2, 1))) - 1
          if (i + 2 > length(value) || high < 0 || low < 0 || high * 16 + low == 0) exit 3
          byte = sprintf("%c", high * 16 + low)
          if (database_path && byte ~ /[\/:?#@&=;+,$]/) exit 3
          i += 2
        }
        result = result byte
      }
      return result
    }

    function destination(url, target,    path, authority, query, args, count, i, separator, key, value, parts) {
      if (url !~ /^postgres(ql)?:\/\// || url ~ /[[:space:]#]/) exit 3
      sub(/^postgres(ql)?:\/\//, "", url)
      i = index(url, "?")
      if (i) {
        query = substr(url, i + 1)
        url = substr(url, 1, i - 1)
      }
      i = index(url, "/")
      if (!i) exit 3
      path = decode(substr(url, i + 1), 1)
      if (path == "" || path == "." || path == ".." || path ~ /\//) exit 3
      target["database"] = path

      authority = substr(url, 1, i - 1)
      sub(/^.*@/, "", authority)
      if (match(authority, /^\[[0-9a-fA-F:.]+\]/)) {
        target["host"] = substr(authority, 2, RLENGTH - 2)
        authority = substr(authority, RLENGTH + 1)
        if (authority != "" && authority !~ /^:[0-9]+$/) exit 3
        target["port"] = substr(authority, 2)
      } else {
        if (split(authority, parts, ":") > 2) exit 3
        target["host"] = decode(parts[1])
        if (target["host"] !~ /^[a-zA-Z0-9_.-]*$/) exit 3
        target["port"] = parts[2]
      }

      count = split(query, args, "&")
      for (i = 1; i <= count; i++) {
        separator = index(args[i] "=", "=")
        key = decode(substr(args[i], 1, separator - 1))
        if (key ~ /^(hostaddr|dbname|database|service|connectionString)$/) exit 3
        if (key == "host" || key == "port") {
          value = decode(substr(args[i], separator + 1))
          if (key == "host" && value !~ /^[a-zA-Z0-9_.-]+$/) exit 3
          if (value == "") exit 3
          target[key] = value
        }
      }
      if (target["host"] == "") exit 3
      if (target["port"] == "") target["port"] = "5432"
      if (target["port"] !~ /^[0-9]+$/ || target["port"] + 0 < 1 || target["port"] + 0 > 65535) exit 3
    }

    function same_server(left, right) {
      return tolower(left["host"]) == tolower(right["host"]) && left["port"] + 0 == right["port"] + 0
    }

    function same_database(left, right) {
      return "db:" left["database"] == "db:" right["database"]
    }

    BEGIN {
      bundled["host"] = ENVIRON["KVITBIT_TARGET_HOST"]
      bundled["port"] = ENVIRON["KVITBIT_TARGET_PORT"]
      bundled["database"] = ENVIRON["KVITBIT_TARGET_DB"]
      owner_url = ENVIRON["KVITBIT_TARGET_OWNER_URL"]
      if (owner_url != "") {
        destination(owner_url, owner)
        if (bundled["database"] != "" && (!same_server(owner, bundled) || !same_database(owner, bundled))) exit 3
        bundled["host"] = owner["host"]
        bundled["port"] = owner["port"]
        bundled["database"] = owner["database"]
      }
      runtime_url = ENVIRON["KVITBIT_RUNTIME_DATABASE_URL"]
      if (runtime_url != "") {
        destination(runtime_url, runtime)
        if (!same_server(runtime, bundled)) exit 1
        if (!same_database(runtime, bundled)) exit 2
      }
      exit 0
    }'
}
