NOTE="$(cat "$STATE_FILE")"
printf 'objective: %s\n' "$NOTE"
printf 'objective | %s\n' "$NOTE"
printf 'objective: %s\n' "$NOTE" || true

render_local_note() {
  local LOCAL_NOTE="$(cat "$OTHER_STATE_FILE")"
  printf 'next_valid_action: %s\n' "$LOCAL_NOTE"
}
