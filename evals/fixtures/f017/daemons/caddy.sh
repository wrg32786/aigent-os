#!/usr/bin/env bash
# Hermetic caddy stand-in for the eval runner's F017 integrity vectors.
# The prompt selects one deterministic child-process/output failure shape.

set -u

input="$(cat)"

case "$input" in
  *"F017 vector V1"*)
    printf '%s\n' '[CADDY] /skill-recall - "partial output before crash"'
    printf '%s\n' 'fixture V1 stderr: caddy crashed after partial output' >&2
    exit 1
    ;;
  *"F017 vector V2"*)
    printf '%s\n' 'fixture V2 stderr-only token: skill-recall xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx F017_V2_TAIL_MUST_BE_TRUNCATED' >&2
    exit 0
    ;;
  *"F017 vector V3 forward"*)
    printf '%s\n' '[CADDY] /seo-research - "fixture exact-identity forward"'
    exit 0
    ;;
  *"F017 vector V3 inverse"*)
    printf '%s\n' '[CADDY] /seo - "fixture exact-identity inverse"'
    exit 0
    ;;
  *"F017 vector V4"*)
    printf '%s\n' '[CADDY:taxonomy] No skill match — run /skill-recall to log this gap'
    exit 0
    ;;
  *"F017 guard signal"*)
    printf '%s\n' 'fixture signal stderr: caddy received TERM' >&2
    kill -TERM "$$"
    exit 143
    ;;
  *"F017 guard description"*)
    printf '%s\n' '[CADDY] /control - "description mentions skill-recall but routes control"'
    exit 0
    ;;
  *"F017 guard taxonomy substring"*)
    printf '%s\n' '[CADDY:taxonomy] skill="[[concepts/SEO Research]] — `/seo-research`" path="content.seo.research" description="fixture taxonomy substring" — [LEDGER]'
    exit 0
    ;;
  *"F017 control scorer A"*)
    printf '%s\n' '[CADDY] /control - "fixture scorer control A"'
    exit 0
    ;;
  *"F017 control scorer B"*)
    printf '%s\n' '[CADDY] /seo - "fixture scorer control B"'
    exit 0
    ;;
  *"F017 control taxonomy"*)
    printf '%s\n' '[CADDY:taxonomy] skill="[[concepts/SEO]] — `/seo`" path="content.seo.audit" description="fixture taxonomy control" — [LEDGER]'
    exit 0
    ;;
  *)
    printf '%s\n' 'fixture caddy received an unknown prompt' >&2
    exit 2
    ;;
esac
