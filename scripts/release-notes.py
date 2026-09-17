"""Select one exact release section; never publish an unreleased or adjacent section."""
import pathlib
import re
import sys


def release_notes(text, tag):
    if not re.fullmatch(r"v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", tag):
        raise ValueError("Invalid release tag")
    lines = text.splitlines(keepends=True)
    headings = [(index, line.rstrip()) for index, line in enumerate(lines) if line.startswith("# ")]
    matches = [position for position, (_, heading) in enumerate(headings) if heading == "# " + tag]
    if len(matches) != 1:
        raise ValueError("Release notes require exactly one heading matching the release tag")
    position = matches[0]
    start = headings[position][0] + 1
    end = headings[position + 1][0] if position + 1 < len(headings) else len(lines)
    body = "".join(lines[start:end]).strip()
    if not body:
        raise ValueError("Release notes must not be empty")
    return body + "\n"


if __name__ == "__main__":
    try:
        print(release_notes(pathlib.Path(sys.argv[2]).read_text(), sys.argv[1]), end="")
    except (ValueError, IndexError) as error:
        sys.exit(str(error))
