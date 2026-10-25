# FON — Fast Object Notation

[![CI](https://github.com/FastObjectNotation/FON.js/actions/workflows/ci.yml/badge.svg)](https://github.com/FastObjectNotation/FON.js/actions/workflows/ci.yml)

A fast, human-readable, line-oriented serialization format — a compact
alternative to JSON for record-style data; each line is one record; values are
typed and can nest.

## Features

- **Compact, readable wire format** — `key=type:value` pairs, one record per line.
- **Typed values** — numeric, bool and string primitives, binary blobs, nested
  objects, and arrays of any of them.
- **Nested objects and arrays of objects**, with a configurable maximum depth.
- **Parallel** dump serialization and deserialization; `maxThreads` caps the worker threads.
- **Editable records** — add, set, replace and remove fields and records in memory.
- **Safe views** — records and nested values read from a dump or collection keep their owner alive, and stale data is reported as an error instead of being read.
- **Byte-oriented parsing** — reads straight from raw UTF-8 bytes.
- **Z85 binary encoding** for raw blobs (5 ASCII characters per 4 bytes).

## Format

Each line is one record: a comma-separated list of `key=type:value` pairs. A
`.fon` file is a sequence of records, indexed by line number (0-based).

```
name=s:"John",age=i:30,balance=d:1234.56
scores=i:[95,87,92],tags=s:["admin","user"]
user=o:{id=i:42,name=s:"Bob",addr=o:{city=s:"NY",zip=i:10001}}
items=o:[{id=i:1,qty=i:5},{id=i:2,qty=i:3}]
blob=r:"0rJua"
```

### Type codes

| Code | JavaScript type | Example                      |
|------|-----------------|------------------------------|
| `e`  | `number`        | `count=e:255`                |
| `t`  | `number`        | `year=t:2024`                |
| `i`  | `number`        | `id=i:42`                    |
| `u`  | `number`        | `flags=u:12345`              |
| `l`  | `bigint`        | `ts=l:1700000000`            |
| `g`  | `bigint`        | `big=g:18446744073709551615` |
| `f`  | `number`        | `ratio=f:3.14`               |
| `d`  | `number`        | `pi=d:3.141592653589793`     |
| `s`  | `string`        | `name=s:"Hello"`             |
| `b`  | `boolean`       | `active=b:1`                 |
| `r`  | `Buffer`        | `data=r:"0rJua"`             |
| `o`  | `FonCollection` | `user=o:{id=i:1}`            |

Every primitive and string type also has an array form (`xs=i:[1,2,3]`), and `o`
supports both nested objects (`{...}`) and arrays of objects (`[{...},{...}]`).
Strings are double-quoted. The characters `"` and `\` and control characters are
escaped: `\n \r \t \b \f \" \\`, and other control characters as `\uXXXX`.

## Install

```bash
npm install fastobjectnotation
```

The package includes the native library for Windows x64, Linux x64 and macOS arm64.
On other platforms, build it from a clone as shown in [Build and test](#build-and-test).

## Usage

### A single record

```js
import { FonCollection, nativeVersion } from 'fastobjectnotation';

console.log(nativeVersion()); // e.g. "0.4.0"

const col = new FonCollection();
col.addInt('id', 42)
   .addString('name', 'Test Item')
   .addDouble('price', 99.99)
   .addBool('active', true)
   .addLong('timestamp', 1700000000n);

const line = col.serialize();
// id=i:42,name=s:"Test Item",price=d:99.99,active=b:1,timestamp=l:1700000000

const parsed = FonCollection.deserialize(line);
console.log(parsed.getInt('id'));         // 42
console.log(parsed.getString('name'));    // "Test Item"
console.log(parsed.getDouble('price'));   // 99.99
console.log(parsed.getBool('active'));    // true
console.log(parsed.getLong('timestamp')); // 1700000000n (bigint)

col.free();
parsed.free();
```

### Many records

```js
import { FonCollection, FonDump } from 'fastobjectnotation';

const dump = new FonDump();

for (let i = 0; i < 1000; i++) {
    dump.add(i, new FonCollection().addInt('id', i).addString('text', `row ${i}`));
}

const text = dump.serialize(); // one line per record; 0 uses all cores

const loaded = FonDump.deserialize(text);
console.log(loaded.size); // 1000

const row5 = loaded.get(5); // view: do not call free() on it
console.log(row5.getString('text')); // "row 5"

dump.free();
loaded.free();
```

### Nested objects and arrays of objects

```js
import { FonCollection } from 'fastobjectnotation';

const order = new FonCollection()
    .addInt('id', 7)
    .addCollection('customer', new FonCollection().addString('name', 'Bob').addString('city', 'NY'))
    .addCollectionArray('items', [
        new FonCollection().addInt('sku', 1).addInt('qty', 5),
        new FonCollection().addInt('sku', 2).addInt('qty', 3),
    ]);

const line = order.serialize();
// id=i:7,customer=o:{name=s:"Bob",city=s:"NY"},items=o:[{sku=i:1,qty=i:5},{sku=i:2,qty=i:3}]

const parsed = FonCollection.deserialize(line);

const customer = parsed.getCollection('customer'); // nested view
console.log(customer.getString('name')); // "Bob"

for (const item of parsed.getCollectionArray('items')) {
    console.log(item.getInt('sku'), item.getInt('qty'));
}

order.free();
parsed.free();
```

### Editing records

Fields: `set` replaces a field (or adds it when absent), `add` requires the key to be
absent, and `remove` returns whether the key existed.

```js
import { FonCollection } from 'fastobjectnotation';

const col = FonCollection.deserialize('name=s:"Ann",age=i:30');

col.setInt('age', 31);           // replaces the field
col.addBool('active', true);     // throws ALREADY_EXISTS if the key is present

console.log(col.remove('name')); // true
console.log(col.keys());         // ['age', 'active']
console.log(col.serialize());    // age=i:31,active=b:1

col.free();
```

Keys may not contain `=`, `"`, `{`, `}`, `[`, `]`, CR or LF; such a key raises
`INVALID_ARGUMENT`.

Records: `add` requires the id to be absent, `set` adds or replaces, `replace`
requires the id to exist (`NOT_FOUND` otherwise), `remove` returns whether the id
existed, and `removeMany` returns how many records were removed.

```js
import { FonCollection, FonDump } from 'fastobjectnotation';

const dump = new FonDump();
dump.add(10, new FonCollection().addString('name', 'a'));
dump.add(20, new FonCollection().addString('name', 'b'));
dump.add(30, new FonCollection().addString('name', 'c'));

dump.set(20, new FonCollection().addString('name', 'B'));
dump.replace(10, new FonCollection().addString('name', 'A'));

console.log(dump.remove(30));    // true
console.log(dump.removeMany([10, 99])); // 1: absent and duplicate ids are ignored
console.log(dump.ids());         // [20]

const rec = dump.get(20);        // record view
rec.setString('name', 'B2');     // a record view stays valid through its own edits
rec.setInt('count', 2);

console.log(dump.serialize());   // name=s:"B2",count=i:2 (ids are renumbered from 0 on save)

dump.free();
```

Ids are stable in memory. Serialization writes the records in ascending id order,
so the saved text numbers them 0 to n-1.

### Binary data and parse options

```js
import { FonCollection, setRawUnpack, setMaxDepth } from 'fastobjectnotation';

const col = new FonCollection().addRaw('blob', new Uint8Array([1, 2, 3, 4]));
const line = col.serialize(); // blob=r:"0rJua"

const parsed = FonCollection.deserialize(line);
console.log(parsed.getRaw('blob')); // <Buffer 01 02 03 04>

setRawUnpack(true); // decode blobs while parsing (default: decoded when read)
setMaxDepth(128);   // nesting limit while parsing (default 64, minimum 1)

col.free();
parsed.free();
```

Both settings are process-wide.

## Memory and lifetime

- **Owned objects** are created by `new FonCollection()`, `new FonDump()`,
  `clone()`, `FonCollection.deserialize()`, `FonDump.deserialize()` and
  `deserializeDumpFromFile()`. Release them with `free()` (or `[Symbol.dispose]()`).
  An owned object that is garbage collected without `free()` is released by a
  finalizer, but do not rely on that for timely release.
- **Views** are returned by `dump.get(id)`, dump iteration (`entries()`, `for...of`),
  `getCollection()`, `getCollectionArray()`, and `get()` for object fields. A view
  never owns memory: `free()` on it does nothing, and it cannot be stored in another
  collection or dump. A view keeps its owner (the dump or the root collection) alive,
  so it stays readable after every other reference to the owner is gone.
- **Stale views.** A view throws `FonError` with code `STALE_VIEW` when the data it
  refers to has changed:
  - A record view goes stale when its record is removed or replaced. Edits made
    through the record view itself keep it valid.
  - A nested view goes stale after any change to its record, or to its root
    collection. Read it again with `getCollection()` or `getCollectionArray()` after
    editing.
- **Disposed owners.** After `free()` on a dump or an owned collection, every view of
  it throws an `Error`. Using an owned object after `free()` or after a transfer also
  throws an `Error`.
- **Ownership transfer.** `dump.add()`, `dump.set()`, `dump.replace()`,
  `addCollection()`, `setCollection()`, `addCollectionArray()` and
  `setCollectionArray()` take ownership of the owned collections passed in. On
  success those collections are unusable (`disposed` is `true`) and must not be
  freed. On failure, such as `ALREADY_EXISTS`, the caller still owns them and must
  free them.
  - A view cannot be stored (`INVALID_ARGUMENT`); call `clone()` first.
  - A collection cannot be stored inside itself or inside its own nested view, and the
    same collection cannot appear twice in one array (`INVALID_ARGUMENT`).
- **`clone()`** returns an independent owned deep copy. It also works on views.
- **Errors** are `FonError` objects with a `code` and the native message, which names
  the key or id: `NOT_FOUND`, `TYPE_MISMATCH`, `ALREADY_EXISTS`, `STALE_VIEW`,
  `INVALID_ARGUMENT`, `PARSE_FAILED`, `WRITE_FAILED` and `FILE_NOT_FOUND`.

## API

### FonCollection

Each kind has `add<Kind>`, `set<Kind>` and `get<Kind>` methods. `add` requires the key to be absent,
`set` adds or replaces the field, and `get` is a typed read. `add` and `set` return the collection, so
calls can be chained. `Long` and `ULong` accept `bigint` or `number` and return `bigint`; `Raw` accepts a
`Uint8Array` and returns a `Buffer`.

| Kind            | add                          | set                          | get                          |
|-----------------|------------------------------|------------------------------|------------------------------|
| Byte            | `addByte(key, value)`        | `setByte(key, value)`        | `getByte(key)`               |
| Short           | `addShort(key, value)`       | `setShort(key, value)`       | `getShort(key)`              |
| Int             | `addInt(key, value)`         | `setInt(key, value)`         | `getInt(key)`                |
| UInt            | `addUInt(key, value)`        | `setUInt(key, value)`        | `getUInt(key)`               |
| Long            | `addLong(key, value)`        | `setLong(key, value)`        | `getLong(key)`               |
| ULong           | `addULong(key, value)`       | `setULong(key, value)`       | `getULong(key)`              |
| Float           | `addFloat(key, value)`       | `setFloat(key, value)`       | `getFloat(key)`              |
| Double          | `addDouble(key, value)`      | `setDouble(key, value)`      | `getDouble(key)`             |
| Bool            | `addBool(key, value)`        | `setBool(key, value)`        | `getBool(key)`               |
| String          | `addString(key, value)`      | `setString(key, value)`      | `getString(key)`             |
| Raw             | `addRaw(key, bytes)`         | `setRaw(key, bytes)`         | `getRaw(key)`                |
| ByteArray       | `addByteArray(key, values)`  | `setByteArray(key, values)`  | `getByteArray(key)`          |
| ShortArray      | `addShortArray(key, values)` | `setShortArray(key, values)` | `getShortArray(key)`         |
| IntArray        | `addIntArray(key, values)`   | `setIntArray(key, values)`   | `getIntArray(key)`           |
| UIntArray       | `addUIntArray(key, values)`  | `setUIntArray(key, values)`  | `getUIntArray(key)`          |
| LongArray       | `addLongArray(key, values)`  | `setLongArray(key, values)`  | `getLongArray(key)`          |
| ULongArray      | `addULongArray(key, values)` | `setULongArray(key, values)` | `getULongArray(key)`         |
| FloatArray      | `addFloatArray(key, values)` | `setFloatArray(key, values)` | `getFloatArray(key)`         |
| DoubleArray     | `addDoubleArray(key, values)`| `setDoubleArray(key, values)`| `getDoubleArray(key)`        |
| BoolArray       | `addBoolArray(key, values)`  | `setBoolArray(key, values)`  | `getBoolArray(key)`          |
| StringArray     | `addStringArray(key, values)`| `setStringArray(key, values)`| `getStringArray(key)`        |
| Collection      | `addCollection(key, child)`  | `setCollection(key, child)`  | `getCollection(key)` (view)  |
| CollectionArray | `addCollectionArray(key, children)` | `setCollectionArray(key, children)` | `getCollectionArray(key)` (views) |

Other members:

| Member                           | Description |
|----------------------------------|-------------|
| `new FonCollection()`            | Creates an empty owned collection. |
| `FonCollection.deserialize(line)`| Parses one line into a new owned collection. |
| `size`                           | Number of fields. |
| `disposed`                       | `true` after `free()` or a transfer. |
| `has(key)`                       | `true` when the key is present. |
| `remove(key)`                    | Removes a field; returns `true` if it existed. |
| `kind(key)`                      | `{ type, array }`, where `type` is a name such as `int` or `string`; `null` when the key is absent. |
| `keys()`                         | Keys in insertion order. |
| `get(key)`                       | Dynamic typed read, chosen by the field's kind; throws `NOT_FOUND` when the key is absent. |
| `clone()`                        | Independent owned deep copy. |
| `serialize()`                    | The collection as one FON line. |
| `free()`                         | Releases an owned collection; does nothing on a view. |
| `assertAlive()`                  | Throws if the object cannot be used. |

### FonDump

| Member                                    | Description |
|-------------------------------------------|-------------|
| `new FonDump()`                           | Creates an empty owned dump. |
| `FonDump.deserialize(text, maxThreads)`   | Parses a multi-line FON string into a new owned dump. |
| `FonDump.deserializeFromFile(path, maxThreads)` | Reads a dump from a file into a new owned dump. |
| `size`                                    | Number of live records. |
| `disposed`                                | `true` after `free()`. |
| `add(id, col)`                            | Adds a record; `ALREADY_EXISTS` if the id is present. Takes ownership of `col`. |
| `set(id, col)`                            | Adds or replaces a record. Takes ownership of `col`. |
| `replace(id, col)`                        | Replaces an existing record; `NOT_FOUND` if the id is absent. Takes ownership of `col`. |
| `remove(id)`                              | Removes a record; returns `true` if it existed. |
| `removeMany(ids)`                         | Removes several records; returns how many were removed. |
| `has(id)`                                 | `true` when the id is present. |
| `ids()`                                   | Live ids in ascending order. Ids above `Number.MAX_SAFE_INTEGER` are returned as `bigint`. |
| `get(id)`                                 | Record view, or `null` when the id is absent. |
| `entries()` / `[Symbol.iterator]()`       | `[id, view]` pairs in ascending id order. |
| `serialize(maxThreads?)`                  | The whole dump as a multi-line string. `0` uses all cores. |
| `serializeToFile(path, maxThreads)`       | Writes the whole dump to a file. |
| `free()`                                  | Releases the dump and invalidates its views. |
| `assertAlive()`                           | Throws if the dump was freed. |

### Module functions and exports

| Name                                             | Description |
|--------------------------------------------------|-------------|
| `nativeVersion()`                                | Version of the native library, e.g. `"0.4.0"`. |
| `setRawUnpack(value)`                            | Decodes raw blobs while parsing. Process-wide; off by default. |
| `setMaxDepth(depth)`                             | Maximum nesting depth while parsing. Process-wide; default 64, minimum 1. |
| `deserializeDumpFromFile(path, maxThreads)`      | Same as `FonDump.deserializeFromFile`. |
| `FonError`                                       | Error with a `code` property; see Memory and lifetime for the codes. |

## Build and test

Requires a stable Rust toolchain and Node.js 18 or later.

```bash
git submodule update --init --recursive
cargo build --release --manifest-path native/Cargo.toml
npm install
npm test
```

The native library is written to `native/target/release/`: `fon_native.dll` on
Windows, `libfon_native.so` on Linux, or `libfon_native.dylib` on macOS. The
package loads it from there, and `npm test` runs the test suite against that build.
