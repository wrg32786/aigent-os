raw = open(state_path, encoding="utf-8").read()
rendered = f"objective: {raw}"
rendered_upper = F"objective: {raw}"
rendered_mixed = f"objective: {inert('label') + raw}"
rendered_triple = f"""objective: {raw}"""
rendered_triple_multiline = f"""
objective: {raw}
"""
annotated: str = open(other_state_path, encoding="utf-8").read()
rendered_annotated = f"next_valid_action: {annotated}"


def context_manager_fstring(p):
    with open(p) as fh: body = fh.read()
    return f"objective: {body}"


def context_manager_format(p):
    with open(p, encoding="utf-8") as fh:
        lines = fh.readlines()
    return "objective: {}".format(lines)


def context_manager_concat(p):
    with open(p) as fh:
        body = fh.read()
    return "objective: " + body
