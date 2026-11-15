"""Check that each architecture doc's draw.io block equals docs/diagrams/<name>.drawio.

Rules (from the project brief): every docs/architecture/*.md has at least one ```xml
block; its first block is byte-identical to docs/diagrams/<stem>.drawio; the XML parses
and is uncompressed (has <mxGraphModel>, no base64 <diagram> body).
"""

import pathlib
import re
import sys
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent.parent
BLOCK = re.compile(r"```xml\n(.*?)```", re.S)


def main() -> int:
    errors: list[str] = []
    docs = sorted((ROOT / "docs/architecture").glob("*.md"))
    for md in docs:
        blocks = BLOCK.findall(md.read_text())
        if not blocks:
            errors.append(f"{md.name}: no ```xml diagram block")
            continue
        drawio = ROOT / "docs/diagrams" / f"{md.stem}.drawio"
        if not drawio.exists():
            errors.append(f"{md.name}: missing {drawio.relative_to(ROOT)}")
            continue
        if blocks[0].strip() != drawio.read_text().strip():
            errors.append(f"{md.name}: first xml block differs from {drawio.name}")
        try:
            tree = ET.fromstring(blocks[0])
        except ET.ParseError as exc:
            errors.append(f"{md.name}: XML does not parse: {exc}")
            continue
        if tree.find(".//mxGraphModel") is None:
            errors.append(f"{md.name}: diagram is compressed or has no mxGraphModel")
    for e in errors:
        print(f"error: {e}", file=sys.stderr)
    print(f"checked {len(docs)} doc(s), {len(errors)} error(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
