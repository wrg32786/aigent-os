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
