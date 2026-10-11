"""Standard-library bootstrap for jobs without a global Node runtime."""
import os
import pathlib
import stat
import uuid


def configure_temporary_storage(env=None):
    env = os.environ if env is None else env
    raw, env_file = env.get("RUNNER_TEMP"), env.get("GITHUB_ENV")
    if not raw or not env_file or any(c in raw + env_file for c in "\r\n\0"):
        raise ValueError("RUNNER_TEMP and GITHUB_ENV must be absolute, single-line paths")
    if not pathlib.Path(raw).is_absolute() or not pathlib.Path(env_file).is_absolute():
        raise ValueError("RUNNER_TEMP and GITHUB_ENV must be absolute, single-line paths")
    initial = os.lstat(raw)
    if stat.S_ISLNK(initial.st_mode) or (
        getattr(initial, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    ):
        raise ValueError("RUNNER_TEMP must not be a directory symlink")
    root = pathlib.Path(raw).resolve(strict=True)
    info = root.stat()
    generic = {pathlib.Path(root.anchor), pathlib.Path.home().resolve(), pathlib.Path.cwd().resolve()}
    if env.get("GITHUB_WORKSPACE"):
        generic.add(pathlib.Path(env["GITHUB_WORKSPACE"]).resolve())
    if not stat.S_ISDIR(info.st_mode) or root in generic or str(root) in ("/tmp", "/var/tmp"):
        raise ValueError("RUNNER_TEMP must name the dedicated job directory, not a shared root")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise ValueError("RUNNER_TEMP is not owned by the job account")
    if not os.access(root, os.W_OK | os.X_OK):
        raise PermissionError("RUNNER_TEMP is not writable by the job account")
    flag = env.get("CI_TEMP_ISOLATE_PROMPTFOO", "false")
    if flag not in ("true", "false", ""):
        raise ValueError("isolate-promptfoo must be true or false")
    probe = root / (".ci-temp-probe-" + str(uuid.uuid4()))
    try:
        fd = os.open(probe, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
    finally:
        probe.unlink(missing_ok=True)
    values = dict.fromkeys(("TMPDIR", "TMP", "TEMP"), str(root))
    values["PYTHONPYCACHEPREFIX"] = str(root / "clued-pycache")
    values["WRANGLER_LOG_PATH"] = str(root / "clued-wrangler-logs")
    if flag == "true":
        values["PROMPTFOO_CONFIG_DIR"] = str(root / "clued-promptfoo")
    with open(env_file, "a", encoding="utf-8", newline="") as output:
        output.write("".join(f"{key}={value}\n" for key, value in values.items()))
    return values


if __name__ == "__main__":
    try:
        values = configure_temporary_storage()
        print("CI temporary storage: " + values["TMPDIR"])
    except (OSError, ValueError) as error:
        raise SystemExit("CI temporary storage refused: " + str(error))
