# FON — Fast Object Notation (JavaScript / Node.js)

[![CI](https://github.com/FastObjectNotation/FON.js/actions/workflows/ci.yml/badge.svg)](https://github.com/FastObjectNotation/FON.js/actions/workflows/ci.yml)

JavaScript / Node.js bindings for FON (Fast Object Notation) via
[koffi](https://koffi.dev) FFI over a pre-built Rust cdylib (`fon_native`).

A fast, human-readable, line-oriented serialization format — a compact
alternative to JSON for record-style data. Each line is one record; values are
typed and can nest.

## Features

- **Compact, readable wire format** — `key=type:value` pairs, one record per line.
- **Typed values** — numeric/bool/string primitives, binary blobs, nested
  objects, and arrays of any of them.
- **Nested objects & arrays of objects**, with a configurable maximum depth.
- **Parallel** dump serialization and deserialization (Rayon-backed, via `maxThreads` arg).
- **Byte-oriented parsing** — reads straight from raw UTF-8 bytes.
- **Z85 binary encoding** for raw blobs (5 ASCII chars per 4 bytes).
- **Zero-copy FFI** — koffi calls directly into the Rust cdylib; no JS parsing layer.

## Format

Each line is one record: a comma-separated list of `key=type:value` pairs. A
`.fon` file is a sequence of records, indexed by line number (0-based).

```
name=s:"John",age=i:30,balance=d:1234.56
scores=i:[95,87,92],tags=s:["admin","user"]
user=o:{id=i:42,name=s:"Bob",addr=o:{city=s:"NY",zip=i:10001}}
items=o:[{id=i:1,qty=i:5},{id=i:2,qty=i:3}]
blob=r:"nm=QNzv..."
```

### Type codes

| Code | Type            | Example                       |
|------|-----------------|-------------------------------|
| `e`  | `u8`            | `count=e:255`                 |
| `t`  | `i16`           | `year=t:2024`                 |
| `i`  | `i32`           | `id=i:42`                     |
| `u`  | `u32`           | `flags=u:12345`               |
| `l`  | `i64`           | `ts=l:1700000000`             |
| `g`  | `u64`           | `big=g:18446744073709551615`  |
| `f`  | `f32`           | `ratio=f:3.14`                |
| `d`  | `f64`           | `pi=d:3.141592653589793`      |
| `s`  | `String`        | `name=s:"Hello"`              |
| `b`  | `bool`          | `active=b:1`                  |
| `r`  | `RawData` (Z85) | `data=r:"nm=QNzv"`            |
| `o`  | `FonCollection` | `user=o:{id=i:1}`             |

Every primitive and string type also has an array form (`xs=i:[1,2,3]`), and `o`
supports both nested objects (`{...}`) and arrays of objects (`[{...},{...}]`).
Strings are double-quoted with `\n \r \t \b \f \" \\` escapes.

## Install

```bash
npm install @fastobjectnotation/fon
```

You also need the native cdylib on your PATH or pre-built in `native/target/release/`.
See [Build](#build) below.

> **GitHub Packages registry:** this package is published to GitHub Packages.
> Add to your project's `.npmrc`:
> ```
> @fastobjectnotation:registry=https://npm.pkg.github.com
> ```

## Usage

### A single record

```js
import { FonCollection, nativeVersion } from '@fastobjectnotation/fon';

console.log(nativeVersion()); // "0.2.1"

const col = new FonCollection();
col.addInt('id', 42)
   .addString('name', 'Test Item')
   .addDouble('price', 99.99)
   .addBool('active', true)
   .addLong('timestamp', 1700000000n);

const line = col.serialize();
// id=i:42,name=s:"Test Item",price=d:99.99,active=b:1,timestamp=l:1700000000

const parsed = FonCollection.deserialize(line);
console.log(parsed.getInt('id'));       // 42
console.log(parsed.getString('name')); // "Test Item"
console.log(parsed.getDouble('price')); // 99.99
console.log(parsed.getBool('active'));  // true
console.log(parsed.getLong('timestamp')); // 1700000000n (BigInt)

col.free();
parsed.free();
```

### Many records (FonDump)

```js
import { FonCollection, FonDump } from '@fastobjectnotation/fon';

const dump = new FonDump();

for (let i = 0; i < 1000; i++) {
    const col = new FonCollection();
    col.addInt('id', i).addString('text', `row ${i}`);
    dump.add(BigInt(i), col); // ownership transfers; col.disposed = true
}

const fon = dump.serialize(0); // 0 = use default Rayon pool

const loaded = FonDump.deserialize(fon);
console.log(loaded.size); // 1000

const row5 = loaded.get(5n); // borrowed — do NOT call row5.free()
console.log(row5.getString('text')); // "row 5"

dump.free();
loaded.free();
```

### Ownership rules

| Call | Effect |
|------|--------|
| `dump.add(id, col)` | `col` is consumed — `col.disposed` becomes `true`. Do NOT free or use `col`. |
| `dump.get(index)` | Returns a **borrowed** handle owned by `dump`. Do NOT call `.free()` on it. |
| `col.free()` | Releases memory. Safe to call only on collections you own. |
| `dump.free()` | Releases memory for the dump and all its collections. |

## Build

The package ships with a git submodule (`native/fon-rust`) that points to the
FON Rust library. After cloning:

```bash
git submodule update --init --recursive
cargo build --release --manifest-path native/Cargo.toml
npm install
npm test
```

The compiled library will be at `native/target/release/fon_native.dll` (Windows),
`libfon_native.so` (Linux), or `libfon_native.dylib` (macOS).
