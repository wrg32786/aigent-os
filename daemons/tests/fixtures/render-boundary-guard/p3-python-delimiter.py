DELIMITER = "---"


def capsule_field(text, key):
    parts = text.split(DELIMITER, 2)
    for line in parts[1].splitlines():
        name, separator, value = line.partition(":")
        if separator and name == key:
            return value.strip()
    return ""


rendered = f"objective: {capsule_field(capsule_text, 'objective')}"

ANNOTATED_DELIMITER: str = "---"


def annotated_capsule_field(text):
    return text.split(ANNOTATED_DELIMITER, 2)[1]
