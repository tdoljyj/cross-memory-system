# ZIP packaging before storage upload

Run with Python 3.12 or later, from the repository root:

```powershell
python scripts/storage/package_zip.py create "C:\work\source-folder" --output "C:\work\candidate.zip"
python scripts/storage/package_zip.py check "C:\work\candidate.zip"
```

Package locally, then upload the checked candidate through the governed Kooyumi
storage connector. Calculate `content_sha256` from the checked final ZIP bytes;
storage preserves those bytes and does not repair entry names during upload.

`create` uses the Python standard library ZIP writer, which sets UTF-8 flag bit 11
for Chinese and other non-ASCII filenames in both local and central headers.
Names use relative paths and forward slashes. The source folder's contents form
the archive root; its own folder name is not added. Empty directories are retained.
The output must be a new file outside the source folder; existing files are never
overwritten. Symbolic links and Windows directory junctions in the source path or
tree are rejected rather than followed.

Creation succeeds only after `check` verifies raw local/central filenames,
matching UTF-8 flags and compression methods, strict UTF-8 encoding, relative
paths and every file's CRC. Both commands reject Windows-forbidden path
characters, trailing dots/spaces, reserved device names, duplicate names and
file/directory layout conflicts. Each path component is conservatively limited to
255 UTF-16 code units, including its extension; an emoji outside the BMP uses two
units. Name collisions are checked conservatively with Unicode case folding;
this is not a complete model of every Windows filesystem's Unicode name comparison.
Entry comments carrying the UTF-8 flag are also checked with strict UTF-8 decoding;
truncated central-directory metadata is rejected.

These checks cover encoding and the listed path constraints, not a universal
Windows extraction guarantee. The full extracted path also depends on the target
directory, filesystem and system/application long-path settings; see Microsoft's
[Windows path limits](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation).

Use the same check before uploading an archive made by another program.
`check` reports an error for legacy non-ASCII filenames without the UTF-8 flag;
it never guesses an encoding or changes an existing package.
