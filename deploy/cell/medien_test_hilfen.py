"""Test files for the media tests (medien_test, clara_apps_test)."""
import uuid


def multipart(felder: dict, datei: tuple) -> tuple[bytes, str]:
    grenze = uuid.uuid4().hex
    teile = []
    for k, v in felder.items():
        teile.append(f'--{grenze}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    feld, name, typ, inhalt = datei
    teile.append(f'--{grenze}\r\nContent-Disposition: form-data; name="{feld}"; filename="{name}"\r\n'
                 f'Content-Type: {typ}\r\n\r\n'.encode() + inhalt + b"\r\n")
    teile.append(f"--{grenze}--\r\n".encode())
    return b"".join(teile), f"multipart/form-data; boundary={grenze}"


def jpeg(text: str) -> bytes:
    """1×1 JPEG with `text` as a comment segment (unique checksum per run)."""
    basis = bytes.fromhex(
        "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c"
        "1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b"
        "080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b510"
        "0002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1"
        "f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a6364656667"
        "68696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2"
        "c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00"
        "fbd3ffd9")
    kommentar = text.encode()
    return basis[:2] + b"\xff\xfe" + (len(kommentar) + 2).to_bytes(2, "big") + kommentar + basis[2:]
