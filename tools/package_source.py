"""Create a source-only ZIP; dataset binaries and Git metadata are not included."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def package_source(project):
    project = Path(project)
    output = project / "dist" / "source.zip"
    files = [
        "LICENSE", "serve.py", "prepare_pages.py", "configure_dataset.py", "configure_tiles.py", "start-local.cmd",
        ".prettierrc.json", ".editorconfig", ".gitignore",
    ]
    files.extend(str(path.relative_to(project)) for path in (project / "dist").iterdir()
                 if path.is_file() and path.name != "source.zip")
    for folder in ("tools", "tests"):
        files.extend(str(path.relative_to(project)) for path in (project / folder).rglob("*")
                     if path.is_file() and "__pycache__" not in path.parts)
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        for name in sorted(set(files)):
            path = project / name
            if path.is_file():
                archive.write(path, name)
    return output


if __name__ == "__main__":
    print(package_source(Path(__file__).resolve().parents[1]))
