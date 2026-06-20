'use strict';

// FON JavaScript bindings — koffi FFI over fon_native cdylib.
//
// Ownership rules (mirroring NativeBindings.cs XML docs):
//   - fon_dump_add(dump, id, collection):  transfers ownership of collection to dump.
//     Caller MUST NOT free or use the collection handle afterwards.
//   - fon_collection_add_collection(parent, key, child):  transfers ownership of child
//     to parent. Caller MUST NOT free or use child afterwards.
//   - fon_collection_add_collection_array(parent, key, children[]):  transfers ownership
//     of every child handle. Caller MUST NOT free or use any of them afterwards.
//   - fon_collection_get_collection / fon_collection_get_collection_array /
//     fon_dump_get:  returns BORROWED handle(s).  Caller MUST NOT free them.

import koffi from 'koffi';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const FON_OK = 0;

// ==================== LIBRARY LOADING ====================

function resolveLibPath() {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(currentDir, '..');
    const candidates = [
        path.join(repoRoot, 'native', 'target', 'release', 'fon_native.dll'),
        path.join(repoRoot, 'native', 'target', 'release', 'libfon_native.so'),
        path.join(repoRoot, 'native', 'target', 'release', 'libfon_native.dylib'),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error(
        `fon_native cdylib not found. Build it first:\n  cargo build --release --manifest-path native/Cargo.toml\n\nSearched:\n${candidates.join('\n')}`
    );
}

const libPath = resolveLibPath();
const lib = koffi.load(libPath);

// ==================== FFI STRUCT ====================

// FonError: int code + uint8[256] message (null-terminated string).
const FonError = koffi.struct('FonError', {
    code: 'int',
    message: koffi.array('uint8', 256),
});

// ==================== FFI FUNCTION PROTOTYPES ====================

// Version — returns a static C string (no ownership transfer, no free).
const ffi_fon_version = lib.func('fon_version', 'const char *', []);

// Dump lifecycle
const ffi_fon_dump_create = lib.func('fon_dump_create', 'void *', []);
const ffi_fon_dump_free = lib.func('fon_dump_free', 'void', ['void *']);
const ffi_fon_dump_size = lib.func('fon_dump_size', 'int64', ['void *']);
const ffi_fon_dump_get = lib.func('fon_dump_get', 'void *', ['void *', 'uint64']);

// fon_dump_add: (dump, id, collection, error*) -> int
// error is an in/out struct pointer; we use koffi.inout to pass a FonError by reference.
const ffi_fon_dump_add = lib.func('fon_dump_add', 'int', [
    'void *',
    'uint64',
    'void *',
    koffi.inout(koffi.pointer(FonError)),
]);

// Collection lifecycle
const ffi_fon_collection_create = lib.func('fon_collection_create', 'void *', []);
const ffi_fon_collection_free = lib.func('fon_collection_free', 'void', ['void *']);
const ffi_fon_collection_size = lib.func('fon_collection_size', 'int64', ['void *']);

// Collection add — error is inout struct pointer
const ffi_fon_collection_add_int = lib.func('fon_collection_add_int', 'int', [
    'void *', 'str', 'int', koffi.inout(koffi.pointer(FonError)),
]);
const ffi_fon_collection_add_long = lib.func('fon_collection_add_long', 'int', [
    'void *', 'str', 'int64', koffi.inout(koffi.pointer(FonError)),
]);
const ffi_fon_collection_add_double = lib.func('fon_collection_add_double', 'int', [
    'void *', 'str', 'double', koffi.inout(koffi.pointer(FonError)),
]);
const ffi_fon_collection_add_bool = lib.func('fon_collection_add_bool', 'int', [
    'void *', 'str', 'int', koffi.inout(koffi.pointer(FonError)),
]);
const ffi_fon_collection_add_string = lib.func('fon_collection_add_string', 'int', [
    'void *', 'str', 'str', koffi.inout(koffi.pointer(FonError)),
]);

// Collection get — scalars use out pointer; error is inout pointer
const ffi_fon_collection_get_int = lib.func('fon_collection_get_int', 'int', [
    'void *', 'str', koffi.out(koffi.pointer('int')), koffi.inout(koffi.pointer(FonError)),
]);
const ffi_fon_collection_get_long = lib.func('fon_collection_get_long', 'int', [
    'void *', 'str', koffi.out(koffi.pointer('int64')), koffi.inout(koffi.pointer(FonError)),
]);
const ffi_fon_collection_get_double = lib.func('fon_collection_get_double', 'int', [
    'void *', 'str', koffi.out(koffi.pointer('double')), koffi.inout(koffi.pointer(FonError)),
]);
const ffi_fon_collection_get_bool = lib.func('fon_collection_get_bool', 'int', [
    'void *', 'str', koffi.out(koffi.pointer('int')), koffi.inout(koffi.pointer(FonError)),
]);

// fon_collection_get_string(collection, key, buffer*uint8, buffer_size int64, error*) -> int
// buffer is a caller-allocated uint8 array written as a null-terminated C string.
// We declare buffer as 'uint8 *' and pass a pre-allocated Buffer.
const ffi_fon_collection_get_string = lib.func('fon_collection_get_string', 'int', [
    'void *', 'str', 'uint8 *', 'int64', koffi.inout(koffi.pointer(FonError)),
]);

// Serialization (two-call pattern):
//   fon_serialize_dump_to_buffer(dump, buffer*, buffer_size, required_size*, max_threads, error*) -> int
//   fon_serialize_collection_to_buffer(collection, buffer*, buffer_size, required_size*, error*) -> int
//
// For call-1 (size query): buffer=null → pass null pointer explicitly.
// For call-2 (fill): pass a pre-allocated Buffer.
// required_size is an out int64 pointer.
const ffi_fon_serialize_dump_to_buffer = lib.func('fon_serialize_dump_to_buffer', 'int', [
    'void *',        // dump
    'uint8 *',       // buffer (nullable)
    'int64',         // buffer_size
    koffi.out(koffi.pointer('int64')), // required_size (out)
    'int',           // max_threads
    koffi.inout(koffi.pointer(FonError)),
]);
const ffi_fon_serialize_collection_to_buffer = lib.func('fon_serialize_collection_to_buffer', 'int', [
    'void *',        // collection
    'uint8 *',       // buffer (nullable)
    'int64',         // buffer_size
    koffi.out(koffi.pointer('int64')), // required_size (out)
    koffi.inout(koffi.pointer(FonError)),
]);

// Deserialization from buffer
const ffi_fon_deserialize_dump_from_buffer = lib.func('fon_deserialize_dump_from_buffer', 'void *', [
    'uint8 *',   // data (nullable when size==0)
    'int64',     // size
    'int',       // max_threads
    koffi.inout(koffi.pointer(FonError)),
]);
const ffi_fon_deserialize_collection_from_buffer = lib.func('fon_deserialize_collection_from_buffer', 'void *', [
    'uint8 *',   // data
    'int64',     // size
    koffi.inout(koffi.pointer(FonError)),
]);

// ==================== CONFIGURATION FFI ====================

// fon_set_raw_unpack(enable: int) -> void
const ffi_fon_set_raw_unpack = lib.func('fon_set_raw_unpack', 'void', ['int']);

// fon_set_max_depth(depth: int) -> void
const ffi_fon_set_max_depth = lib.func('fon_set_max_depth', 'void', ['int']);

// ==================== FILE I/O FFI ====================

// fon_serialize_to_file(dump, path, max_threads, error*) -> int
const ffi_fon_serialize_to_file = lib.func('fon_serialize_to_file', 'int', [
    'void *',   // dump
    'str',      // path (UTF-8 C string)
    'int',      // max_threads
    koffi.inout(koffi.pointer(FonError)),
]);

// fon_deserialize_from_file(path, max_threads, error*) -> void*
const ffi_fon_deserialize_from_file = lib.func('fon_deserialize_from_file', 'void *', [
    'str',      // path (UTF-8 C string)
    'int',      // max_threads
    koffi.inout(koffi.pointer(FonError)),
]);

// ==================== ARRAY FFI ====================

// fon_collection_add_int_array(collection, key, values*, count, error*) -> int
const ffi_fon_collection_add_int_array = lib.func('fon_collection_add_int_array', 'int', [
    'void *', 'str', 'int *', 'int64', koffi.inout(koffi.pointer(FonError)),
]);

// fon_collection_get_int_array(collection, key, buffer*|null, buffer_size, actual_size*, error*) -> int
const ffi_fon_collection_get_int_array = lib.func('fon_collection_get_int_array', 'int', [
    'void *', 'str', 'int *', 'int64',
    koffi.out(koffi.pointer('int64')),
    koffi.inout(koffi.pointer(FonError)),
]);

// fon_collection_add_float_array(collection, key, values*, count, error*) -> int
const ffi_fon_collection_add_float_array = lib.func('fon_collection_add_float_array', 'int', [
    'void *', 'str', 'float *', 'int64', koffi.inout(koffi.pointer(FonError)),
]);

// fon_collection_get_float_array(collection, key, buffer*|null, buffer_size, actual_size*, error*) -> int
const ffi_fon_collection_get_float_array = lib.func('fon_collection_get_float_array', 'int', [
    'void *', 'str', 'float *', 'int64',
    koffi.out(koffi.pointer('int64')),
    koffi.inout(koffi.pointer(FonError)),
]);

// ==================== NESTED COLLECTION FFI ====================

// fon_collection_add_collection(parent, key, child, error*) -> int  [ownership transfer]
const ffi_fon_collection_add_collection = lib.func('fon_collection_add_collection', 'int', [
    'void *', 'str', 'void *', koffi.inout(koffi.pointer(FonError)),
]);

// fon_collection_get_collection(parent, key, error*) -> void*  [borrowed]
const ffi_fon_collection_get_collection = lib.func('fon_collection_get_collection', 'void *', [
    'void *', 'str', koffi.inout(koffi.pointer(FonError)),
]);

// fon_collection_add_collection_array(parent, key, children**, count, error*) -> int  [ownership transfer]
// Pass a JS array of opaque handles; koffi maps them into a void** on the native side.
const ffi_fon_collection_add_collection_array = lib.func('fon_collection_add_collection_array', 'int', [
    'void *', 'str', 'void **', 'int64', koffi.inout(koffi.pointer(FonError)),
]);

// Size-query variant: pass uint8* null buffer to get the element count.
const ffi_fon_collection_get_collection_array_size = lib.func('fon_collection_get_collection_array', 'int', [
    'void *', 'str', 'uint8 *', 'int64',
    koffi.out(koffi.pointer('int64')),
    koffi.inout(koffi.pointer(FonError)),
]);
// Fill variant: created dynamically per call using a fixed-size koffi.array type.
// (No single global declaration here; see getCollectionArray implementation.)

// ==================== HELPERS ====================

function decodeErrorStruct(err) {
    const bytes = err.message;
    let end = bytes.indexOf(0);
    if (end === -1) { end = bytes.length; }
    const msg = Buffer.from(bytes.slice(0, end)).toString('utf8');
    return new Error(`FON error ${err.code}: ${msg}`);
}

function makeError() {
    return { code: 0, message: new Array(256).fill(0) };
}

// Two-call buffer serialization helper.
// Abstracts the size-query + fill pattern for dump and collection serialize.
//
// dumpCall: (ptr, buffer|null, bufferSize, sizeOut, ...extraArgs, err) -> int
function serializeHandleToString(ptr, extraArgs, ffiFunc) {
    const err1 = makeError();
    const sizeOut = [0n];

    // Call 1: pass null for buffer, 0 for size → fills sizeOut.
    const rc1 = ffiFunc(ptr, null, 0n, sizeOut, ...extraArgs, err1);
    if (rc1 !== FON_OK) {
        throw decodeErrorStruct(err1);
    }

    const size = Number(sizeOut[0]);
    if (size === 0) {
        return '';
    }

    // Call 2: allocate exact buffer and fill it.
    const buf = Buffer.alloc(size);
    const sizeOut2 = [0n];
    const err2 = makeError();
    const rc2 = ffiFunc(ptr, buf, BigInt(size), sizeOut2, ...extraArgs, err2);
    if (rc2 !== FON_OK) {
        throw decodeErrorStruct(err2);
    }

    return buf.toString('utf8');
}

// ==================== PUBLIC API ====================

/**
 * Returns the native library version string (e.g. "0.2.1").
 * @returns {string}
 */
function nativeVersion() {
    return ffi_fon_version();
}

/**
 * Enables or disables raw unpack mode for deserialization (global setting).
 * @param {boolean} value
 */
function setRawUnpack(value) {
    ffi_fon_set_raw_unpack(value ? 1 : 0);
}

/**
 * Sets the maximum recursion depth for deserialization (global setting).
 * @param {number} depth
 */
function setMaxDepth(depth) {
    ffi_fon_set_max_depth(depth | 0);
}

/**
 * FonCollection — wraps a heap-allocated FonCollection handle.
 *
 * Ownership: when disposed=true the handle has been transferred to a FonDump
 * or parent FonCollection (via add* calls) and MUST NOT be freed or used.
 */
class FonCollection {
    constructor() {
        this.handle = ffi_fon_collection_create();
        if (!this.handle) {
            throw new Error('fon_collection_create returned null');
        }
        this.disposed = false;
    }

    assertAlive() {
        if (this.disposed) {
            throw new Error('FonCollection handle has been transferred and is no longer usable');
        }
    }

    free() {
        if (!this.disposed) {
            ffi_fon_collection_free(this.handle);
            this.disposed = true;
        }
    }

    get size() {
        this.assertAlive();
        return Number(ffi_fon_collection_size(this.handle));
    }

    // -- Add methods --

    addInt(key, value) {
        this.assertAlive();
        const err = makeError();
        const rc = ffi_fon_collection_add_int(this.handle, key, value | 0, err);
        if (rc !== FON_OK) { throw decodeErrorStruct(err); }
        return this;
    }

    addLong(key, value) {
        this.assertAlive();
        const err = makeError();
        const rc = ffi_fon_collection_add_long(this.handle, key, BigInt(value), err);
        if (rc !== FON_OK) { throw decodeErrorStruct(err); }
        return this;
    }

    addDouble(key, value) {
        this.assertAlive();
        const err = makeError();
        const rc = ffi_fon_collection_add_double(this.handle, key, value, err);
        if (rc !== FON_OK) { throw decodeErrorStruct(err); }
        return this;
    }

    addBool(key, value) {
        this.assertAlive();
        const err = makeError();
        const rc = ffi_fon_collection_add_bool(this.handle, key, value ? 1 : 0, err);
        if (rc !== FON_OK) { throw decodeErrorStruct(err); }
        return this;
    }

    addString(key, value) {
        this.assertAlive();
        const err = makeError();
        const rc = ffi_fon_collection_add_string(this.handle, key, value, err);
        if (rc !== FON_OK) { throw decodeErrorStruct(err); }
        return this;
    }

    /**
     * Stores an array of 32-bit integers under key. The JS array is copied into
     * a native Int32Array before the FFI call.
     * @param {string} key
     * @param {number[]} values
     */
    addIntArray(key, values) {
        this.assertAlive();
        const native = new Int32Array(values);
        const err = makeError();
        const rc = ffi_fon_collection_add_int_array(this.handle, key, native, BigInt(native.length), err);
        if (rc !== FON_OK) { throw decodeErrorStruct(err); }
        return this;
    }

    /**
     * Stores an array of 32-bit floats under key.
     * @param {string} key
     * @param {number[]} values
     */
    addFloatArray(key, values) {
        this.assertAlive();
        const native = new Float32Array(values);
        const err = makeError();
        const rc = ffi_fon_collection_add_float_array(this.handle, key, native, BigInt(native.length), err);
        if (rc !== FON_OK) { throw decodeErrorStruct(err); }
        return this;
    }

    /**
     * Adds a nested FonCollection under key.
     * OWNERSHIP TRANSFER: child.disposed is set to true; do not use or free child.
     * @param {string} key
     * @param {FonCollection} child
     */
    addCollection(key, child) {
        this.assertAlive();
        child.assertAlive();
        const err = makeError();
        const rc = ffi_fon_collection_add_collection(this.handle, key, child.handle, err);
        if (rc !== FON_OK) { throw decodeErrorStruct(err); }
        child.disposed = true; // ownership transferred to parent
        return this;
    }

    /**
     * Adds an array of nested FonCollections under key.
     * OWNERSHIP TRANSFER: every element's disposed is set to true.
     * @param {string} key
     * @param {FonCollection[]} children
     */
    addCollectionArray(key, children) {
        this.assertAlive();
        for (const child of children) {
            child.assertAlive();
        }
        // Build a Buffer of raw pointer values (8 bytes each on 64-bit).
        // koffi expects a 'void **' — pass an array of opaque handle values.
        // We use koffi's ability to accept a JS array of void* when the param type is 'void **'.
        const handles = children.map((c) => c.handle);
        const err = makeError();
        const rc = ffi_fon_collection_add_collection_array(
            this.handle, key, handles, BigInt(handles.length), err
        );
        if (rc !== FON_OK) { throw decodeErrorStruct(err); }
        for (const child of children) {
            child.disposed = true; // ownership transferred to parent
        }
        return this;
    }

    // -- Get methods --

    getInt(key) {
        this.assertAlive();
        const err = makeError();
        const out = [0];
        const rc = ffi_fon_collection_get_int(this.handle, key, out, err);
        if (rc !== FON_OK) { throw decodeErrorStruct(err); }
        return out[0];
    }

    getLong(key) {
        this.assertAlive();
        const err = makeError();
        const out = [0n];
        const rc = ffi_fon_collection_get_long(this.handle, key, out, err);
        if (rc !== FON_OK) { throw decodeErrorStruct(err); }
        // koffi may return int64 as a JS number or BigInt depending on magnitude;
        // normalise to BigInt for a consistent API.
        return BigInt(out[0]);
    }

    getDouble(key) {
        this.assertAlive();
        const err = makeError();
        const out = [0.0];
        const rc = ffi_fon_collection_get_double(this.handle, key, out, err);
        if (rc !== FON_OK) { throw decodeErrorStruct(err); }
        return out[0];
    }

    getBool(key) {
        this.assertAlive();
        const err = makeError();
        const out = [0];
        const rc = ffi_fon_collection_get_bool(this.handle, key, out, err);
        if (rc !== FON_OK) { throw decodeErrorStruct(err); }
        return out[0] !== 0;
    }

    getString(key) {
        this.assertAlive();
        const err = makeError();
        // Allocate a 4096-byte output buffer for the null-terminated C string.
        const bufSize = 4096n;
        const buf = Buffer.alloc(Number(bufSize));
        const rc = ffi_fon_collection_get_string(this.handle, key, buf, bufSize, err);
        if (rc !== FON_OK) { throw decodeErrorStruct(err); }
        // Find null terminator and decode UTF-8.
        let end = buf.indexOf(0);
        if (end === -1) { end = buf.length; }
        return buf.slice(0, end).toString('utf8');
    }

    /**
     * Returns an array of 32-bit integers stored under key (two-call pattern).
     * @param {string} key
     * @returns {number[]}
     */
    getIntArray(key) {
        this.assertAlive();
        // Call 1: null buffer → read actual element count.
        const sizeOut = [0n];
        const err1 = makeError();
        const rc1 = ffi_fon_collection_get_int_array(this.handle, key, null, 0n, sizeOut, err1);
        if (rc1 !== FON_OK) { throw decodeErrorStruct(err1); }
        const count = Number(sizeOut[0]);
        if (count === 0) { return []; }
        // Call 2: allocate typed buffer and fill.
        const buf = new Int32Array(count);
        const sizeOut2 = [0n];
        const err2 = makeError();
        const rc2 = ffi_fon_collection_get_int_array(this.handle, key, buf, BigInt(count), sizeOut2, err2);
        if (rc2 !== FON_OK) { throw decodeErrorStruct(err2); }
        return Array.from(buf);
    }

    /**
     * Returns an array of 32-bit floats stored under key (two-call pattern).
     * @param {string} key
     * @returns {number[]}
     */
    getFloatArray(key) {
        this.assertAlive();
        // Call 1: null buffer → read actual element count.
        const sizeOut = [0n];
        const err1 = makeError();
        const rc1 = ffi_fon_collection_get_float_array(this.handle, key, null, 0n, sizeOut, err1);
        if (rc1 !== FON_OK) { throw decodeErrorStruct(err1); }
        const count = Number(sizeOut[0]);
        if (count === 0) { return []; }
        // Call 2: allocate typed buffer and fill.
        const buf = new Float32Array(count);
        const sizeOut2 = [0n];
        const err2 = makeError();
        const rc2 = ffi_fon_collection_get_float_array(this.handle, key, buf, BigInt(count), sizeOut2, err2);
        if (rc2 !== FON_OK) { throw decodeErrorStruct(err2); }
        return Array.from(buf);
    }

    /**
     * Returns a BORROWED FonCollection stored under key. Do NOT free it.
     * @param {string} key
     * @returns {FonCollection}
     */
    getCollection(key) {
        this.assertAlive();
        const err = makeError();
        const ptr = ffi_fon_collection_get_collection(this.handle, key, err);
        if (!ptr) { throw decodeErrorStruct(err); }
        const col = Object.create(FonCollection.prototype);
        col.handle = ptr;
        col.disposed = false;
        return col;
    }

    /**
     * Returns an array of BORROWED FonCollections stored under key (two-call pattern).
     * Do NOT free any of the returned handles.
     * @param {string} key
     * @returns {FonCollection[]}
     */
    getCollectionArray(key) {
        this.assertAlive();
        // Call 1: pass null uint8* buffer to query element count only.
        const sizeOut = [0n];
        const err1 = makeError();
        const rc1 = ffi_fon_collection_get_collection_array_size(
            this.handle, key, null, 0n, sizeOut, err1
        );
        if (rc1 !== FON_OK) { throw decodeErrorStruct(err1); }
        const count = Number(sizeOut[0]);
        if (count === 0) { return []; }
        // Call 2: create a fixed-size void* array type for this count so koffi
        // can properly fill each pointer slot on return.
        const PtrArrayN = koffi.array('void *', count);
        const ffi_fill = lib.func('fon_collection_get_collection_array', 'int', [
            'void *', 'str', koffi.out(koffi.pointer(PtrArrayN)), 'int64',
            koffi.out(koffi.pointer('int64')),
            koffi.inout(koffi.pointer(FonError)),
        ]);
        const ptrs = [[]];
        const sizeOut2 = [0n];
        const err2 = makeError();
        const rc2 = ffi_fill(this.handle, key, ptrs, BigInt(count), sizeOut2, err2);
        if (rc2 !== FON_OK) { throw decodeErrorStruct(err2); }
        return ptrs[0].map((ptr) => {
            const col = Object.create(FonCollection.prototype);
            col.handle = ptr;
            col.disposed = false;
            return col;
        });
    }

    // -- Serialization --

    /**
     * Serializes this collection to a FON line string (two-call pattern).
     * @returns {string}
     */
    serialize() {
        this.assertAlive();
        return serializeHandleToString(this.handle, [], ffi_fon_serialize_collection_to_buffer);
    }

    /**
     * Parses a single FON line into a new FonCollection.
     * @param {string} line
     * @returns {FonCollection}
     */
    static deserialize(line) {
        const bytes = Buffer.from(line, 'utf8');
        const err = makeError();
        const handle = ffi_fon_deserialize_collection_from_buffer(bytes, BigInt(bytes.length), err);
        if (!handle) { throw decodeErrorStruct(err); }
        const col = Object.create(FonCollection.prototype);
        col.handle = handle;
        col.disposed = false;
        return col;
    }
}

/**
 * FonDump — wraps a heap-allocated FonDump handle (id -> FonCollection map).
 */
class FonDump {
    constructor() {
        this.handle = ffi_fon_dump_create();
        if (!this.handle) {
            throw new Error('fon_dump_create returned null');
        }
        this.disposed = false;
    }

    assertAlive() {
        if (this.disposed) {
            throw new Error('FonDump has already been freed');
        }
    }

    free() {
        if (!this.disposed) {
            ffi_fon_dump_free(this.handle);
            this.disposed = true;
        }
    }

    get size() {
        this.assertAlive();
        return Number(ffi_fon_dump_size(this.handle));
    }

    /**
     * Adds a collection to the dump under the given numeric id.
     * OWNERSHIP TRANSFER: after this call, col.disposed is set to true.
     * The caller MUST NOT use or free col afterwards.
     * @param {number|bigint} id
     * @param {FonCollection} col
     */
    add(id, col) {
        this.assertAlive();
        col.assertAlive();
        const err = makeError();
        const rc = ffi_fon_dump_add(this.handle, BigInt(id), col.handle, err);
        if (rc !== FON_OK) { throw decodeErrorStruct(err); }
        col.disposed = true; // ownership transferred to dump
        return this;
    }

    /**
     * Returns a BORROWED FonCollection at the given index. Do NOT free it.
     * @param {number|bigint} index
     * @returns {FonCollection|null}
     */
    get(index) {
        this.assertAlive();
        const ptr = ffi_fon_dump_get(this.handle, BigInt(index));
        if (!ptr) { return null; }
        const col = Object.create(FonCollection.prototype);
        col.handle = ptr;
        col.disposed = false;
        return col;
    }

    /**
     * Serializes the entire dump to a multi-line FON string.
     * @param {number} [maxThreads=0]
     * @returns {string}
     */
    serialize(maxThreads = 0) {
        this.assertAlive();
        return serializeHandleToString(this.handle, [maxThreads], ffi_fon_serialize_dump_to_buffer);
    }

    /**
     * Writes the dump directly to a file at the given path.
     * @param {string} filePath
     * @param {number} [maxThreads=0]
     */
    serializeToFile(filePath, maxThreads = 0) {
        this.assertAlive();
        const err = makeError();
        const rc = ffi_fon_serialize_to_file(this.handle, filePath, maxThreads | 0, err);
        if (rc !== FON_OK) { throw decodeErrorStruct(err); }
    }

    /**
     * Parses a multi-line FON buffer into a new FonDump.
     * @param {string} text
     * @param {number} [maxThreads=0]
     * @returns {FonDump}
     */
    static deserialize(text, maxThreads = 0) {
        const bytes = Buffer.from(text, 'utf8');
        const err = makeError();
        const handle = ffi_fon_deserialize_dump_from_buffer(bytes, BigInt(bytes.length), maxThreads, err);
        if (!handle) { throw decodeErrorStruct(err); }
        const dump = Object.create(FonDump.prototype);
        dump.handle = handle;
        dump.disposed = false;
        return dump;
    }
}

/**
 * Reads a FON dump directly from a file.
 * @param {string} filePath
 * @param {number} [maxThreads=0]
 * @returns {FonDump}
 */
function deserializeDumpFromFile(filePath, maxThreads = 0) {
    const err = makeError();
    const handle = ffi_fon_deserialize_from_file(filePath, maxThreads | 0, err);
    if (!handle) { throw decodeErrorStruct(err); }
    const dump = Object.create(FonDump.prototype);
    dump.handle = handle;
    dump.disposed = false;
    return dump;
}

export { FonCollection, FonDump, nativeVersion, setRawUnpack, setMaxDepth, deserializeDumpFromFile };
