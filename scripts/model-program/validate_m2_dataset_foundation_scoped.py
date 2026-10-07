from validate_m2_scoped_successor import main, validate_envelope
def validate(envelope, **options):
    return validate_envelope(envelope, "dataset_foundation", **options)
if __name__ == "__main__":
    raise SystemExit(main("dataset_foundation"))
