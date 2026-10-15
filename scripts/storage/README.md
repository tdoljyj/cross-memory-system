# ZIP packaging before storage upload

Run with Python 3.12 or later, from the repository root:

```powershell
python scripts/storage/package_zip.py create "G:\path\source-folder" --output "G:\path\new-package.zip"
python scripts/storage/package_zip.py check "G:\path\new-package.zip"
```

`create` uses the Python standard library ZIP writer, which sets UTF-8 flag bit 11
for Chinese and other non-ASCII filenames in both local and central headers.
Names use relative paths and forward slashes. Empty directories are retained.
The output must be a new file outside the source folder; existing files are never
overwritten. Symbolic links and Windows directory junctions in the source path or
tree are rejected rather than followed.

Creation succeeds only after `check` verifies raw local/central filenames,
matching UTF-8 flags, strict UTF-8 encoding, relative paths and every file's CRC.
Entry comments carrying the UTF-8 flag are also checked with strict UTF-8 decoding;
truncated central-directory metadata is rejected.
Use the same check before uploading an archive made by another program.
`check` reports an error for legacy non-ASCII filenames without the UTF-8 flag;
it never guesses an encoding or changes an existing package.
