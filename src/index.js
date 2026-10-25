'use strict';

// FON (Fast Object Notation) for JavaScript, backed by a native library.
//
// Object model:
//   - Owned collection: created by the constructor, clone() or FonCollection.deserialize().
//     Owns a native handle, released by free(), by transfer into a dump or another collection,
//     or by the garbage collector.
//   - Dump: created by the constructor or FonDump.deserialize*(). Owns a native handle.
//   - View: a collection read from a dump (record view) or from a collection/view getter
//     (nested view). Views never own native memory and hold a strong reference to their root
//     owner, so the owner stays alive for as long as any view does.
//
// Every root owner keeps a version counter that every mutation performed on its tree increments.
// A view compares it with the value captured at its last validation; when it differs, the view
// re-checks the native record generation (dump roots) or the tree version (collection roots)
// before using its cached handle, and raises STALE_VIEW if the target changed.
//
// Ownership: a collection passed to add/set (as a field value), to addCollectionArray, or to
// FonDump.add/set/replace must be an owned, live root collection. On success the collection object
// is transferred and becomes unusable; on failure the caller keeps ownership and it stays usable.

import koffi from 'koffi';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

// ==================== CONSTANTS ====================

const FON_OK = 0;
const FON_PUT_ADD = 0;
const FON_PUT_SET = 1;
const FON_PUT_UPSERT = 2;
const FON_KIND_ARRAY = 0x100;

const ERROR_CODE_NAMES = {
    1: 'FILE_NOT_FOUND',
    2: 'PARSE_FAILED',
    3: 'WRITE_FAILED',
    4: 'INVALID_ARGUMENT',
    5: 'BUFFER_TOO_SMALL',
    6: 'NOT_FOUND',
    7: 'TYPE_MISMATCH',
    8: 'ALREADY_EXISTS',
    9: 'STALE_VIEW',
};

const TYPE_NAMES = {
    e: 'byte',
    t: 'short',
    i: 'int',
    u: 'uint',
    l: 'long',
    g: 'ulong',
    f: 'float',
    d: 'double',
    b: 'bool',
    s: 'string',
    r: 'raw',
    o: 'object',
};

const TRANSFERRED_MESSAGE = 'FonCollection handle has been transferred or freed and is no longer usable';
const FREED_DUMP_MESSAGE = 'FonDump has already been freed';
const OWNER_GONE_MESSAGE = 'this view belongs to a FonDump or FonCollection that has been freed or transferred';

const I32_MIN = -0x80000000;
const I32_MAX = 0x7FFFFFFF;
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const U64_MAX = 2n ** 64n - 1n;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const kState = Symbol('fon.state');
const disposeKey = Symbol.dispose ?? Symbol.for('nodejs.dispose');

// ==================== LIBRARY LOADING ====================

// Libraries shipped in the npm package, named by the release workflow. A library built in
// native/target/release takes precedence.
const PREBUILT_LIBS = {
    'win32-x64': 'fon_native-windows-x64.dll',
    'linux-x64': 'libfon_native-linux-x64.so',
    'darwin-arm64': 'libfon_native-macos-arm64.dylib',
};

function resolveLibPath() {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(currentDir, '..');
    const prebuilt = PREBUILT_LIBS[`${process.platform}-${process.arch}`];
    const candidates = [
        path.join(repoRoot, 'native', 'target', 'release', 'fon_native.dll'),
        path.join(repoRoot, 'native', 'target', 'release', 'libfon_native.so'),
        path.join(repoRoot, 'native', 'target', 'release', 'libfon_native.dylib'),
        ...(prebuilt ? [path.join(repoRoot, 'prebuilds', prebuilt)] : []),
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

const lib = koffi.load(resolveLibPath());

// ==================== FFI TYPES ====================

// FonError { int32 code; char message[256]; } is 260 bytes: int32 code at offset 0, then the
// NUL-terminated UTF-8 message. It is passed as a plain pointer to a reusable Buffer, because
// marshalling a 256-element JS array on every call dominated the cost of small reads.
const FON_ERROR_SIZE = 260;
const INOUT_ERR = 'void *';

// Scalar out-parameters: pass a single-element array, koffi writes the value back into it.
const OUT_U8 = koffi.out(koffi.pointer('uint8'));
const OUT_I16 = koffi.out(koffi.pointer('int16'));
const OUT_I32 = koffi.out(koffi.pointer('int32'));
const OUT_U32 = koffi.out(koffi.pointer('uint32'));
const OUT_I64 = koffi.out(koffi.pointer('int64'));
const OUT_U64 = koffi.out(koffi.pointer('uint64'));
const OUT_F32 = koffi.out(koffi.pointer('float'));
const OUT_F64 = koffi.out(koffi.pointer('double'));

// ==================== FFI FUNCTION PROTOTYPES ====================

const ffi_fon_version = lib.func('fon_version', 'const char *', []);
const ffi_fon_set_raw_unpack = lib.func('fon_set_raw_unpack', 'void', ['int32']);
const ffi_fon_set_max_depth = lib.func('fon_set_max_depth', 'void', ['int32']);
// Declared as void* so that any External returned by the library is accepted back.
const ffi_fon_buffer_free = lib.func('fon_buffer_free', 'void', ['void *', 'int64']);

// Collection: lifecycle and introspection
const ffi_fon_collection_create = lib.func('fon_collection_create', 'void *', []);
const ffi_fon_collection_free = lib.func('fon_collection_free', 'void', ['void *']);
const ffi_fon_collection_size = lib.func('fon_collection_size', 'int64', ['void *']);
const ffi_fon_collection_clone = lib.func('fon_collection_clone', 'void *', ['void *', INOUT_ERR]);
const ffi_fon_collection_kind_of = lib.func('fon_collection_kind_of', 'int32', ['void *', 'uint8 *', 'int64']);
const ffi_fon_collection_keys = lib.func('fon_collection_keys', 'int32', [
    'void *',
    'int64 *', 'int64',
    'uint8 *', 'int64',
    'int32 *',
    OUT_I64, OUT_I64,
    INOUT_ERR,
]);
const ffi_fon_collection_remove = lib.func('fon_collection_remove', 'int32', ['void *', 'uint8 *', 'int64']);

// Collection: put (scalars)
const ffi_fon_collection_put_byte = lib.func('fon_collection_put_byte', 'int32', ['void *', 'uint8 *', 'int64', 'uint8', 'int32', INOUT_ERR]);
const ffi_fon_collection_put_short = lib.func('fon_collection_put_short', 'int32', ['void *', 'uint8 *', 'int64', 'int16', 'int32', INOUT_ERR]);
const ffi_fon_collection_put_int = lib.func('fon_collection_put_int', 'int32', ['void *', 'uint8 *', 'int64', 'int32', 'int32', INOUT_ERR]);
const ffi_fon_collection_put_uint = lib.func('fon_collection_put_uint', 'int32', ['void *', 'uint8 *', 'int64', 'uint32', 'int32', INOUT_ERR]);
const ffi_fon_collection_put_long = lib.func('fon_collection_put_long', 'int32', ['void *', 'uint8 *', 'int64', 'int64', 'int32', INOUT_ERR]);
const ffi_fon_collection_put_ulong = lib.func('fon_collection_put_ulong', 'int32', ['void *', 'uint8 *', 'int64', 'uint64', 'int32', INOUT_ERR]);
const ffi_fon_collection_put_float = lib.func('fon_collection_put_float', 'int32', ['void *', 'uint8 *', 'int64', 'float', 'int32', INOUT_ERR]);
const ffi_fon_collection_put_double = lib.func('fon_collection_put_double', 'int32', ['void *', 'uint8 *', 'int64', 'double', 'int32', INOUT_ERR]);
const ffi_fon_collection_put_bool = lib.func('fon_collection_put_bool', 'int32', ['void *', 'uint8 *', 'int64', 'int32', 'int32', INOUT_ERR]);

// Collection: put (string, raw, arrays)
const ffi_fon_collection_put_string = lib.func('fon_collection_put_string', 'int32', ['void *', 'uint8 *', 'int64', 'uint8 *', 'int64', 'int32', INOUT_ERR]);
const ffi_fon_collection_put_raw = lib.func('fon_collection_put_raw', 'int32', ['void *', 'uint8 *', 'int64', 'uint8 *', 'int64', 'int32', INOUT_ERR]);
const ffi_fon_collection_put_byte_array = lib.func('fon_collection_put_byte_array', 'int32', ['void *', 'uint8 *', 'int64', 'uint8 *', 'int64', 'int32', INOUT_ERR]);
const ffi_fon_collection_put_short_array = lib.func('fon_collection_put_short_array', 'int32', ['void *', 'uint8 *', 'int64', 'int16 *', 'int64', 'int32', INOUT_ERR]);
const ffi_fon_collection_put_int_array = lib.func('fon_collection_put_int_array', 'int32', ['void *', 'uint8 *', 'int64', 'int32 *', 'int64', 'int32', INOUT_ERR]);
const ffi_fon_collection_put_uint_array = lib.func('fon_collection_put_uint_array', 'int32', ['void *', 'uint8 *', 'int64', 'uint32 *', 'int64', 'int32', INOUT_ERR]);
const ffi_fon_collection_put_long_array = lib.func('fon_collection_put_long_array', 'int32', ['void *', 'uint8 *', 'int64', 'int64 *', 'int64', 'int32', INOUT_ERR]);
const ffi_fon_collection_put_ulong_array = lib.func('fon_collection_put_ulong_array', 'int32', ['void *', 'uint8 *', 'int64', 'uint64 *', 'int64', 'int32', INOUT_ERR]);
const ffi_fon_collection_put_float_array = lib.func('fon_collection_put_float_array', 'int32', ['void *', 'uint8 *', 'int64', 'float *', 'int64', 'int32', INOUT_ERR]);
const ffi_fon_collection_put_double_array = lib.func('fon_collection_put_double_array', 'int32', ['void *', 'uint8 *', 'int64', 'double *', 'int64', 'int32', INOUT_ERR]);
const ffi_fon_collection_put_bool_array = lib.func('fon_collection_put_bool_array', 'int32', ['void *', 'uint8 *', 'int64', 'uint8 *', 'int64', 'int32', INOUT_ERR]);
const ffi_fon_collection_put_string_array = lib.func('fon_collection_put_string_array', 'int32', [
    'void *',
    'uint8 *', 'int64',
    'int64 *', 'uint8 *', 'int64',
    'int32',
    INOUT_ERR,
]);
const ffi_fon_collection_put_collection = lib.func('fon_collection_put_collection', 'int32', ['void *', 'uint8 *', 'int64', 'void *', 'int32', INOUT_ERR]);
const ffi_fon_collection_put_collection_array = lib.func('fon_collection_put_collection_array', 'int32', [
    'void *',
    'uint8 *', 'int64',
    'void **', 'int64',
    'int32',
    INOUT_ERR,
]);

// Collection: get (scalars)
const ffi_fon_collection_get_byte = lib.func('fon_collection_get_byte', 'int32', ['void *', 'uint8 *', 'int64', OUT_U8, INOUT_ERR]);
const ffi_fon_collection_get_short = lib.func('fon_collection_get_short', 'int32', ['void *', 'uint8 *', 'int64', OUT_I16, INOUT_ERR]);
const ffi_fon_collection_get_int = lib.func('fon_collection_get_int', 'int32', ['void *', 'uint8 *', 'int64', OUT_I32, INOUT_ERR]);
const ffi_fon_collection_get_uint = lib.func('fon_collection_get_uint', 'int32', ['void *', 'uint8 *', 'int64', OUT_U32, INOUT_ERR]);
const ffi_fon_collection_get_long = lib.func('fon_collection_get_long', 'int32', ['void *', 'uint8 *', 'int64', OUT_I64, INOUT_ERR]);
const ffi_fon_collection_get_ulong = lib.func('fon_collection_get_ulong', 'int32', ['void *', 'uint8 *', 'int64', OUT_U64, INOUT_ERR]);
const ffi_fon_collection_get_float = lib.func('fon_collection_get_float', 'int32', ['void *', 'uint8 *', 'int64', OUT_F32, INOUT_ERR]);
const ffi_fon_collection_get_double = lib.func('fon_collection_get_double', 'int32', ['void *', 'uint8 *', 'int64', OUT_F64, INOUT_ERR]);
const ffi_fon_collection_get_bool = lib.func('fon_collection_get_bool', 'int32', ['void *', 'uint8 *', 'int64', OUT_I32, INOUT_ERR]);

// Collection: get (string, raw, arrays); size-query pattern
const ffi_fon_collection_get_string = lib.func('fon_collection_get_string', 'int32', ['void *', 'uint8 *', 'int64', 'uint8 *', 'int64', OUT_I64, INOUT_ERR]);
const ffi_fon_collection_get_raw = lib.func('fon_collection_get_raw', 'int32', ['void *', 'uint8 *', 'int64', 'uint8 *', 'int64', OUT_I64, INOUT_ERR]);
const ffi_fon_collection_get_byte_array = lib.func('fon_collection_get_byte_array', 'int32', ['void *', 'uint8 *', 'int64', 'uint8 *', 'int64', OUT_I64, INOUT_ERR]);
const ffi_fon_collection_get_short_array = lib.func('fon_collection_get_short_array', 'int32', ['void *', 'uint8 *', 'int64', 'int16 *', 'int64', OUT_I64, INOUT_ERR]);
const ffi_fon_collection_get_int_array = lib.func('fon_collection_get_int_array', 'int32', ['void *', 'uint8 *', 'int64', 'int32 *', 'int64', OUT_I64, INOUT_ERR]);
const ffi_fon_collection_get_uint_array = lib.func('fon_collection_get_uint_array', 'int32', ['void *', 'uint8 *', 'int64', 'uint32 *', 'int64', OUT_I64, INOUT_ERR]);
const ffi_fon_collection_get_long_array = lib.func('fon_collection_get_long_array', 'int32', ['void *', 'uint8 *', 'int64', 'int64 *', 'int64', OUT_I64, INOUT_ERR]);
const ffi_fon_collection_get_ulong_array = lib.func('fon_collection_get_ulong_array', 'int32', ['void *', 'uint8 *', 'int64', 'uint64 *', 'int64', OUT_I64, INOUT_ERR]);
const ffi_fon_collection_get_float_array = lib.func('fon_collection_get_float_array', 'int32', ['void *', 'uint8 *', 'int64', 'float *', 'int64', OUT_I64, INOUT_ERR]);
const ffi_fon_collection_get_double_array = lib.func('fon_collection_get_double_array', 'int32', ['void *', 'uint8 *', 'int64', 'double *', 'int64', OUT_I64, INOUT_ERR]);
const ffi_fon_collection_get_bool_array = lib.func('fon_collection_get_bool_array', 'int32', ['void *', 'uint8 *', 'int64', 'uint8 *', 'int64', OUT_I64, INOUT_ERR]);
const ffi_fon_collection_get_string_array = lib.func('fon_collection_get_string_array', 'int32', [
    'void *',
    'uint8 *', 'int64',
    'int64 *', 'int64',
    'uint8 *', 'int64',
    OUT_I64, OUT_I64,
    INOUT_ERR,
]);

// Collection: get (nested, borrowed)
const ffi_fon_collection_get_collection = lib.func('fon_collection_get_collection', 'void *', ['void *', 'uint8 *', 'int64', INOUT_ERR]);
const ffi_fon_collection_get_collection_array = lib.func('fon_collection_get_collection_array', 'int32', [
    'void *',
    'uint8 *', 'int64',
    'void **', 'int64',
    OUT_I64,
    INOUT_ERR,
]);

// Dump
const ffi_fon_dump_create = lib.func('fon_dump_create', 'void *', []);
const ffi_fon_dump_free = lib.func('fon_dump_free', 'void', ['void *']);
const ffi_fon_dump_size = lib.func('fon_dump_size', 'int64', ['void *']);
const ffi_fon_dump_ids = lib.func('fon_dump_ids', 'int32', ['void *', 'uint64 *', 'int64', OUT_I64, INOUT_ERR]);
const ffi_fon_dump_get = lib.func('fon_dump_get', 'void *', ['void *', 'uint64']);
const ffi_fon_dump_put = lib.func('fon_dump_put', 'int32', ['void *', 'uint64', 'void *', 'int32', INOUT_ERR]);
const ffi_fon_dump_remove = lib.func('fon_dump_remove', 'int32', ['void *', 'uint64']);
const ffi_fon_dump_remove_many = lib.func('fon_dump_remove_many', 'int64', ['void *', 'uint64 *', 'int64']);
// The generation outputs are plain 4-byte Buffers: they are read on every view access, and
// koffi out-pointers cost several microseconds per call.
const ffi_fon_dump_gens = lib.func('fon_dump_gens', 'int32', ['void *', 'uint64', 'void *', 'void *']);
const ffi_fon_dump_touch = lib.func('fon_dump_touch', 'int32', ['void *', 'uint64']);

// Serialize / deserialize
const ffi_fon_serialize_dump = lib.func('fon_serialize_dump', 'int32', ['void *', 'int32', koffi.out(koffi.pointer('uint8 *')), OUT_I64, INOUT_ERR]);
const ffi_fon_serialize_collection = lib.func('fon_serialize_collection', 'int32', ['void *', koffi.out(koffi.pointer('uint8 *')), OUT_I64, INOUT_ERR]);
const ffi_fon_serialize_to_file = lib.func('fon_serialize_to_file', 'int32', ['void *', 'uint8 *', 'int64', 'int32', INOUT_ERR]);
const ffi_fon_deserialize_dump = lib.func('fon_deserialize_dump', 'void *', ['uint8 *', 'int64', 'int32', INOUT_ERR]);
const ffi_fon_deserialize_collection = lib.func('fon_deserialize_collection', 'void *', ['uint8 *', 'int64', INOUT_ERR]);
const ffi_fon_deserialize_from_file = lib.func('fon_deserialize_from_file', 'void *', ['uint8 *', 'int64', 'int32', INOUT_ERR]);

// ==================== ERRORS ====================

/**
 * Error raised for native FON result codes.
 * `code` is the symbolic result name: NOT_FOUND, TYPE_MISMATCH, ALREADY_EXISTS, STALE_VIEW,
 * INVALID_ARGUMENT, PARSE_FAILED, WRITE_FAILED, FILE_NOT_FOUND, BUFFER_TOO_SMALL.
 */
class FonError extends Error {
    /**
     * @param {string} code Symbolic result code.
     * @param {string} message Message from the native library.
     */
    constructor(code, message) {
        super(message);
        this.name = 'FonError';
        this.code = code;
    }
}

function decodeErrorMessage(err) {
    const end = err.indexOf(0, 4);
    return err.toString('utf8', 4, end === -1 ? FON_ERROR_SIZE : end);
}

// One shared error buffer: every call reads its own error immediately after the native call.
const sharedError = Buffer.alloc(FON_ERROR_SIZE);

function makeError() {
    sharedError.fill(0);
    return sharedError;
}

/**
 * @param {number} rc Result code returned by the native call.
 * @param {object} err Error struct filled by the native call.
 * @returns {FonError}
 */
function nativeError(rc, err) {
    const code = ERROR_CODE_NAMES[rc] ?? 'UNKNOWN';
    const message = decodeErrorMessage(err) || `fon_native returned ${rc} (${code})`;
    return new FonError(code, message);
}

function ensureOk(rc, err) {
    if (rc !== FON_OK) {
        throw nativeError(rc, err);
    }
}

// ==================== ARGUMENT CONVERSION ====================

/**
 * @param {*} value
 * @param {string} label
 * @returns {Buffer} UTF-8 bytes of the string (embedded U+0000 is kept).
 */
function stringBytes(value, label) {
    if (typeof value !== 'string') {
        throw new TypeError(`${label} must be a string`);
    }
    return Buffer.from(value, 'utf8');
}

function checkedInt(value, min, max, label) {
    if (typeof value !== 'number') {
        throw new TypeError(`${label} must be a number`);
    }
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new RangeError(`${label} must be an integer in [${min}, ${max}], got ${value}`);
    }
    return value;
}

function checkedBigInt(value, min, max, label) {
    let big;
    if (typeof value === 'bigint') {
        big = value;
    } else if (typeof value === 'number' && Number.isInteger(value)) {
        big = BigInt(value);
    } else {
        throw new TypeError(`${label} must be an integer (number or bigint)`);
    }
    if (big < min || big > max) {
        throw new RangeError(`${label} must be in [${min}, ${max}], got ${big}`);
    }
    return big;
}

function checkedNumber(value, label) {
    if (typeof value !== 'number') {
        throw new TypeError(`${label} must be a number`);
    }
    return value;
}

function toUint64(id) {
    return checkedBigInt(id, 0n, U64_MAX, 'dump id');
}

function toThreads(maxThreads) {
    return checkedInt(maxThreads, I32_MIN, I32_MAX, 'maxThreads');
}

function assertArrayLike(values, label) {
    if (!Array.isArray(values) && !ArrayBuffer.isView(values)) {
        throw new TypeError(`${label} must be an array`);
    }
}

function toTypedArray(Ctor, values, convert, label) {
    assertArrayLike(values, label);
    const out = new Ctor(values.length);
    for (let i = 0; i < values.length; i++) {
        out[i] = convert(values[i]);
    }
    return out;
}

function toPlainArray(values, convert, label) {
    assertArrayLike(values, label);
    return Array.from(values, (value) => convert(value));
}

function rawBytes(value) {
    if (!(value instanceof Uint8Array)) {
        throw new TypeError('raw value must be a Uint8Array or Buffer');
    }
    return value;
}

function decodeKind(code) {
    const type = TYPE_NAMES[String.fromCharCode(code & 0xFF)];
    if (type === undefined) {
        throw new Error(`unknown FON value kind code ${code}`);
    }
    return { type, array: (code & FON_KIND_ARRAY) !== 0 };
}

function toSafeId(id) {
    return id <= MAX_SAFE_BIGINT ? Number(id) : id;
}

// ==================== NATIVE MEMORY HELPERS ====================

// Runs fn with a stable native buffer of `count` elements of `type`, freed afterwards.
// Used for 64-bit element arrays, which koffi transfers through decode() rather than typed arrays.
function withAlloc(type, count, fn) {
    const memory = koffi.alloc(type, count);
    try {
        return fn(memory);
    } finally {
        koffi.free(memory);
    }
}

// Copies a library-owned byte buffer into JS and releases it.
function takeNativeBytes(ptr, len) {
    const size = Number(len);
    if (!ptr) {
        return Buffer.alloc(0);
    }
    try {
        return size === 0 ? Buffer.alloc(0) : Buffer.from(koffi.decode(ptr, 'uint8', size));
    } finally {
        ffi_fon_buffer_free(ptr, BigInt(size));
    }
}

function splitStrings(bytes, lengths) {
    const items = new Array(lengths.length);
    let offset = 0;
    for (let i = 0; i < lengths.length; i++) {
        const length = Number(lengths[i]);
        items[i] = bytes.toString('utf8', offset, offset + length);
        offset += length;
    }
    return items;
}

// Element count of an array/string value, from a size-query call (buffer = NULL).
function queryLength(ffiFn, handle, keyBuf) {
    const actual = [0n];
    const err = makeError();
    const rc = ffiFn(handle, keyBuf, BigInt(keyBuf.length), null, 0n, actual, err);
    ensureOk(rc, err);
    return Number(actual[0]);
}

// ==================== OBJECT STATE AND FINALIZATION ====================

function attachState(obj, state) {
    Object.defineProperty(obj, kState, { value: state, enumerable: false });
}

function stateOf(obj) {
    const state = obj ? obj[kState] : undefined;
    if (state === undefined) {
        throw new TypeError('expected a FON collection or dump');
    }
    return state;
}

// Owned collections and dumps release their native handle when garbage collected.
// The held value must not reference the wrapper, or the wrapper could never be collected.
const releaseRegistry = new FinalizationRegistry((held) => {
    if (held.kind === 'dump') {
        ffi_fon_dump_free(held.handle);
    } else {
        ffi_fon_collection_free(held.handle);
    }
});

function initOwnedCollection(obj, handle) {
    attachState(obj, { owned: true, handle, disposed: false, version: 0, treeVersion: 0 });
    releaseRegistry.register(obj, { kind: 'collection', handle }, obj);
}

function initOwnedDump(obj, handle) {
    attachState(obj, { handle, disposed: false, version: 0 });
    releaseRegistry.register(obj, { kind: 'dump', handle }, obj);
}

function wrapOwnedCollection(handle) {
    const col = Object.create(FonCollection.prototype);
    initOwnedCollection(col, handle);
    return col;
}

function wrapOwnedDump(handle) {
    const dump = Object.create(FonDump.prototype);
    initOwnedDump(dump, handle);
    return dump;
}

function dumpStateOf(dump) {
    const st = stateOf(dump);
    if (st.disposed) {
        throw new Error(FREED_DUMP_MESSAGE);
    }
    return st;
}

function rootOfCollection(col) {
    const st = stateOf(col);
    return st.owned ? col : st.root;
}

// ==================== VIEW VALIDATION ====================

function staleError() {
    return new FonError('STALE_VIEW', 'stale view: the record or nested collection it refers to was removed, replaced or changed');
}

/**
 * Reads the record and tree generations of a dump record.
 * @returns {{recordGen: number, treeGen: number}|null} null when the id is absent.
 */
function readGens(dumpHandle, id) {
    const recordGen = Buffer.alloc(4);
    const treeGen = Buffer.alloc(4);
    if (ffi_fon_dump_gens(dumpHandle, id, recordGen, treeGen) !== 1) {
        return null;
    }
    return { recordGen: recordGen.readUInt32LE(0), treeGen: treeGen.readUInt32LE(0) };
}

function revalidateView(st, rootState) {
    if (st.id === null) {
        if (rootState.treeVersion !== st.rootTreeVersion) {
            throw staleError();
        }
    } else {
        const gens = readGens(rootState.handle, st.id);
        if (gens === null || gens.recordGen !== st.recordGen) {
            throw staleError();
        }
        if (st.nested && gens.treeGen !== st.treeGen) {
            throw staleError();
        }
        st.treeGen = gens.treeGen;
        if (!st.nested) {
            // Record pointers may move on any dump mutation, so a record view re-resolves them.
            const handle = ffi_fon_dump_get(rootState.handle, st.id);
            if (!handle) {
                throw staleError();
            }
            st.handle = handle;
        }
    }
    st.cachedVersion = rootState.version;
}

/**
 * Returns the native handle of a collection after validating it (owned, or view against its root).
 */
function resolveHandle(col) {
    const st = stateOf(col);
    if (st.owned) {
        if (st.disposed) {
            throw new Error(TRANSFERRED_MESSAGE);
        }
        return st.handle;
    }
    const rootState = stateOf(st.root);
    if (rootState.disposed) {
        throw new Error(OWNER_GONE_MESSAGE);
    }
    if (rootState.version !== st.cachedVersion) {
        revalidateView(st, rootState);
    }
    return st.handle;
}

/**
 * Brings the captured generations of a mutated object up to date and bumps the root versions.
 * Other views of the same tree are left alone and fail validation on their next access.
 */
function noteMutation(col) {
    const st = stateOf(col);
    if (st.owned) {
        st.treeVersion += 1;
        st.version += 1;
        return;
    }
    const rootState = stateOf(st.root);
    if (st.id === null) {
        rootState.treeVersion += 1;
        rootState.version += 1;
        st.rootTreeVersion = rootState.treeVersion;
        st.cachedVersion = rootState.version;
        return;
    }
    ffi_fon_dump_touch(rootState.handle, st.id);
    rootState.version += 1;
    const gens = readGens(rootState.handle, st.id);
    if (gens === null) {
        throw staleError();
    }
    st.recordGen = gens.recordGen;
    st.treeGen = gens.treeGen;
    st.cachedVersion = rootState.version;
    if (!st.nested) {
        const handle = ffi_fon_dump_get(rootState.handle, st.id);
        if (!handle) {
            throw staleError();
        }
        st.handle = handle;
    }
}

function openRecordView(dump, id) {
    const st = dumpStateOf(dump);
    const handle = ffi_fon_dump_get(st.handle, id);
    if (!handle) {
        return null;
    }
    const gens = readGens(st.handle, id);
    if (gens === null) {
        return null;
    }
    const view = Object.create(FonCollection.prototype);
    attachState(view, {
        owned: false,
        handle,
        root: dump,
        id,
        recordGen: gens.recordGen,
        treeGen: gens.treeGen,
        rootTreeVersion: 0,
        cachedVersion: st.version,
        nested: false,
    });
    return view;
}

function openNestedView(parent, childHandle) {
    const parentState = stateOf(parent);
    const rootObj = parentState.owned ? parent : parentState.root;
    const rootState = stateOf(rootObj);
    const view = Object.create(FonCollection.prototype);
    if (rootObj instanceof FonDump) {
        attachState(view, {
            owned: false,
            handle: childHandle,
            root: rootObj,
            id: parentState.id,
            recordGen: parentState.recordGen,
            treeGen: parentState.treeGen,
            rootTreeVersion: 0,
            cachedVersion: rootState.version,
            nested: true,
        });
    } else {
        attachState(view, {
            owned: false,
            handle: childHandle,
            root: rootObj,
            id: null,
            recordGen: 0,
            treeGen: 0,
            rootTreeVersion: rootState.treeVersion,
            cachedVersion: rootState.version,
            nested: true,
        });
    }
    return view;
}

// ==================== OWNERSHIP TRANSFER ====================

/**
 * Checks that `child` may be transferred into `target` (a collection, or null for a dump).
 * Does not change any state; returns the child's native handle.
 */
function claimChild(child, target) {
    if (!(child instanceof FonCollection)) {
        throw new TypeError('the value must be a FonCollection');
    }
    const childState = stateOf(child);
    if (!childState.owned) {
        throw new FonError('INVALID_ARGUMENT', 'a view cannot be stored in another collection or dump; call clone() first');
    }
    if (childState.disposed) {
        throw new Error(TRANSFERRED_MESSAGE);
    }
    if (target !== null) {
        if (target === child) {
            throw new FonError('INVALID_ARGUMENT', 'a collection cannot be stored in itself');
        }
        if (rootOfCollection(target) === child) {
            throw new FonError('INVALID_ARGUMENT', 'storing a collection inside its own nested view would create a cycle');
        }
    }
    return childState.handle;
}

// Called after the native put succeeded: the wrapper no longer owns the handle.
function releaseChild(child) {
    const childState = stateOf(child);
    childState.disposed = true;
    releaseRegistry.unregister(child);
}

// ==================== COLLECTION PUT / GET HELPERS ====================

function putScalar(col, key, mode, ffiFn, value) {
    const handle = resolveHandle(col);
    const keyBuf = stringBytes(key, 'key');
    const err = makeError();
    const rc = ffiFn(handle, keyBuf, BigInt(keyBuf.length), value, mode, err);
    ensureOk(rc, err);
    noteMutation(col);
    return col;
}

function putBytes(col, key, mode, ffiFn, bytes) {
    const handle = resolveHandle(col);
    const keyBuf = stringBytes(key, 'key');
    const err = makeError();
    const rc = ffiFn(handle, keyBuf, BigInt(keyBuf.length), bytes, BigInt(bytes.length), mode, err);
    ensureOk(rc, err);
    noteMutation(col);
    return col;
}

function putArray(col, key, mode, ffiFn, values) {
    const handle = resolveHandle(col);
    const keyBuf = stringBytes(key, 'key');
    const err = makeError();
    const rc = ffiFn(handle, keyBuf, BigInt(keyBuf.length), values, BigInt(values.length), mode, err);
    ensureOk(rc, err);
    noteMutation(col);
    return col;
}

function putStringArray(col, key, mode, values) {
    assertArrayLike(values, 'values');
    const encoded = Array.from(values, (value) => stringBytes(value, 'string array item'));
    const lengths = encoded.map((bytes) => BigInt(bytes.length));
    const bytes = Buffer.concat(encoded);
    const handle = resolveHandle(col);
    const keyBuf = stringBytes(key, 'key');
    const err = makeError();
    const rc = ffi_fon_collection_put_string_array(handle, keyBuf, BigInt(keyBuf.length), lengths, bytes, BigInt(encoded.length), mode, err);
    ensureOk(rc, err);
    noteMutation(col);
    return col;
}

function putChild(target, key, mode, child) {
    const handle = resolveHandle(target);
    const keyBuf = stringBytes(key, 'key');
    const childHandle = claimChild(child, target);
    const err = makeError();
    const rc = ffi_fon_collection_put_collection(handle, keyBuf, BigInt(keyBuf.length), childHandle, mode, err);
    ensureOk(rc, err);
    releaseChild(child);
    noteMutation(target);
    return target;
}

function putChildren(target, key, mode, children) {
    if (!Array.isArray(children)) {
        throw new TypeError('children must be an array of FonCollection');
    }
    const handle = resolveHandle(target);
    const keyBuf = stringBytes(key, 'key');
    const seen = new Set();
    const handles = children.map((child) => {
        if (seen.has(child)) {
            throw new FonError('INVALID_ARGUMENT', 'the same collection appears more than once in the array');
        }
        seen.add(child);
        return claimChild(child, target);
    });
    const err = makeError();
    const rc = ffi_fon_collection_put_collection_array(handle, keyBuf, BigInt(keyBuf.length), handles, BigInt(handles.length), mode, err);
    ensureOk(rc, err);
    for (const child of children) {
        releaseChild(child);
    }
    noteMutation(target);
    return target;
}

function getScalar(col, key, ffiFn, initial) {
    const handle = resolveHandle(col);
    const keyBuf = stringBytes(key, 'key');
    const out = [initial];
    const err = makeError();
    const rc = ffiFn(handle, keyBuf, BigInt(keyBuf.length), out, err);
    ensureOk(rc, err);
    return out[0];
}

function getBytes(col, key, ffiFn) {
    const handle = resolveHandle(col);
    const keyBuf = stringBytes(key, 'key');
    const size = queryLength(ffiFn, handle, keyBuf);
    if (size === 0) {
        return Buffer.alloc(0);
    }
    const buffer = Buffer.alloc(size);
    const actual = [0n];
    const err = makeError();
    const rc = ffiFn(handle, keyBuf, BigInt(keyBuf.length), buffer, BigInt(size), actual, err);
    ensureOk(rc, err);
    return buffer.subarray(0, Number(actual[0]));
}

function getTypedArray(col, key, ffiFn, Ctor) {
    const handle = resolveHandle(col);
    const keyBuf = stringBytes(key, 'key');
    const count = queryLength(ffiFn, handle, keyBuf);
    if (count === 0) {
        return [];
    }
    const buffer = new Ctor(count);
    const actual = [0n];
    const err = makeError();
    const rc = ffiFn(handle, keyBuf, BigInt(keyBuf.length), buffer, BigInt(count), actual, err);
    ensureOk(rc, err);
    return Array.from(buffer.subarray(0, Number(actual[0])));
}

function getWideArray(col, key, ffiFn, typeName) {
    const handle = resolveHandle(col);
    const keyBuf = stringBytes(key, 'key');
    const count = queryLength(ffiFn, handle, keyBuf);
    if (count === 0) {
        return [];
    }
    return withAlloc(typeName, count, (memory) => {
        const actual = [0n];
        const err = makeError();
        const rc = ffiFn(handle, keyBuf, BigInt(keyBuf.length), memory, BigInt(count), actual, err);
        ensureOk(rc, err);
        const filled = Number(actual[0]);
        if (filled === 0) {
            return [];
        }
        return Array.from(koffi.decode(memory, typeName, filled), (value) => BigInt(value));
    });
}

function getStringArray(col, key) {
    const handle = resolveHandle(col);
    const keyBuf = stringBytes(key, 'key');
    const klen = BigInt(keyBuf.length);
    const countOut = [0n];
    const totalOut = [0n];
    let err = makeError();
    const rc = ffi_fon_collection_get_string_array(handle, keyBuf, klen, null, 0n, null, 0n, countOut, totalOut, err);
    ensureOk(rc, err);
    const count = Number(countOut[0]);
    if (count === 0) {
        return [];
    }
    const total = Number(totalOut[0]);
    return withAlloc('int64', count, (lengths) => {
        const bytes = Buffer.alloc(total);
        const countOut2 = [0n];
        const totalOut2 = [0n];
        err = makeError();
        const rc2 = ffi_fon_collection_get_string_array(handle, keyBuf, klen, lengths, BigInt(count), bytes, BigInt(total), countOut2, totalOut2, err);
        ensureOk(rc2, err);
        return splitStrings(bytes, koffi.decode(lengths, 'int64', count));
    });
}

function getCollectionArray(col, key) {
    const handle = resolveHandle(col);
    const keyBuf = stringBytes(key, 'key');
    const klen = BigInt(keyBuf.length);
    const count = queryLength(ffi_fon_collection_get_collection_array, handle, keyBuf);
    if (count === 0) {
        return [];
    }
    return withAlloc('void *', count, (memory) => {
        const actual = [0n];
        const err = makeError();
        const rc = ffi_fon_collection_get_collection_array(handle, keyBuf, klen, memory, BigInt(count), actual, err);
        ensureOk(rc, err);
        const filled = Number(actual[0]);
        if (filled === 0) {
            return [];
        }
        return koffi.decode(memory, 'void *', filled).map((ptr) => {
            if (!ptr) {
                throw new Error('fon_collection_get_collection_array returned a null element');
            }
            return openNestedView(col, ptr);
        });
    });
}

// Reads all keys with their kinds in one fon_collection_keys round trip after the size query.
function readEntries(col) {
    const handle = resolveHandle(col);
    const countOut = [0n];
    const totalOut = [0n];
    let err = makeError();
    const rc = ffi_fon_collection_keys(handle, null, 0n, null, 0n, null, countOut, totalOut, err);
    ensureOk(rc, err);
    const count = Number(countOut[0]);
    if (count === 0) {
        return [];
    }
    const total = Number(totalOut[0]);
    return withAlloc('int64', count, (lengths) => {
        const bytes = Buffer.alloc(total);
        const kinds = new Int32Array(count);
        const countOut2 = [0n];
        const totalOut2 = [0n];
        err = makeError();
        const rc2 = ffi_fon_collection_keys(handle, lengths, BigInt(count), bytes, BigInt(total), kinds, countOut2, totalOut2, err);
        ensureOk(rc2, err);
        const keyLengths = koffi.decode(lengths, 'int64', count);
        const entries = new Array(count);
        let offset = 0;
        for (let i = 0; i < count; i++) {
            const length = Number(keyLengths[i]);
            entries[i] = {
                key: bytes.toString('utf8', offset, offset + length),
                kind: decodeKind(kinds[i]),
            };
            offset += length;
        }
        return entries;
    });
}

// ==================== DUMP HELPERS ====================

function readDumpIds(dump) {
    const st = dumpStateOf(dump);
    const countOut = [0n];
    let err = makeError();
    const rc = ffi_fon_dump_ids(st.handle, null, 0n, countOut, err);
    ensureOk(rc, err);
    const count = Number(countOut[0]);
    if (count === 0) {
        return [];
    }
    return withAlloc('uint64', count, (memory) => {
        const actual = [0n];
        err = makeError();
        const rc2 = ffi_fon_dump_ids(st.handle, memory, BigInt(count), actual, err);
        ensureOk(rc2, err);
        const filled = Number(actual[0]);
        if (filled === 0) {
            return [];
        }
        return Array.from(koffi.decode(memory, 'uint64', filled), (value) => BigInt(value));
    });
}

function putRecord(dump, id, mode, col) {
    const st = dumpStateOf(dump);
    const key = toUint64(id);
    const childHandle = claimChild(col, null);
    const err = makeError();
    const rc = ffi_fon_dump_put(st.handle, key, childHandle, mode, err);
    ensureOk(rc, err);
    releaseChild(col);
    st.version += 1;
    return dump;
}

// ==================== FonCollection ====================

/**
 * A FON collection: an ordered set of typed key/value fields.
 *
 * An owned collection (constructor, clone(), deserialize()) must be freed with free() or
 * transferred into a dump or another collection. A collection read from a dump or from another
 * collection is a view: it never owns memory, and free() on it does nothing.
 */
class FonCollection {
    /**
     * Creates an empty owned collection.
     */
    constructor() {
        const handle = ffi_fon_collection_create();
        if (!handle) {
            throw new Error('fon_collection_create returned null');
        }
        initOwnedCollection(this, handle);
    }

    /** Number of key/value fields. */
    get size() {
        return Number(ffi_fon_collection_size(resolveHandle(this)));
    }

    /** True when this object can no longer be used because it was freed or transferred. */
    get disposed() {
        const st = stateOf(this);
        if (st.owned) {
            return st.disposed;
        }
        return stateOf(st.root).disposed;
    }

    /** Throws if this object cannot be used (freed, transferred, or a stale view). */
    assertAlive() {
        resolveHandle(this);
    }

    /**
     * Frees an owned collection. No-op if it was already freed or transferred, and on views.
     */
    free() {
        const st = stateOf(this);
        if (!st.owned || st.disposed) {
            return;
        }
        ffi_fon_collection_free(st.handle);
        st.disposed = true;
        releaseRegistry.unregister(this);
    }

    [disposeKey]() {
        this.free();
    }

    // -- Add (key must not exist) --

    /** @param {string} key @param {number} value @returns {this} */
    addByte(key, value) {
        return putScalar(this, key, FON_PUT_ADD, ffi_fon_collection_put_byte, checkedInt(value, 0, 0xFF, 'byte'));
    }

    addShort(key, value) {
        return putScalar(this, key, FON_PUT_ADD, ffi_fon_collection_put_short, checkedInt(value, -0x8000, 0x7FFF, 'short'));
    }

    addInt(key, value) {
        return putScalar(this, key, FON_PUT_ADD, ffi_fon_collection_put_int, checkedInt(value, I32_MIN, I32_MAX, 'int'));
    }

    addUInt(key, value) {
        return putScalar(this, key, FON_PUT_ADD, ffi_fon_collection_put_uint, checkedInt(value, 0, 0xFFFFFFFF, 'uint'));
    }

    /** @param {string} key @param {bigint|number} value @returns {this} */
    addLong(key, value) {
        return putScalar(this, key, FON_PUT_ADD, ffi_fon_collection_put_long, checkedBigInt(value, I64_MIN, I64_MAX, 'long'));
    }

    addULong(key, value) {
        return putScalar(this, key, FON_PUT_ADD, ffi_fon_collection_put_ulong, checkedBigInt(value, 0n, U64_MAX, 'ulong'));
    }

    addFloat(key, value) {
        return putScalar(this, key, FON_PUT_ADD, ffi_fon_collection_put_float, checkedNumber(value, 'float'));
    }

    addDouble(key, value) {
        return putScalar(this, key, FON_PUT_ADD, ffi_fon_collection_put_double, checkedNumber(value, 'double'));
    }

    addBool(key, value) {
        return putScalar(this, key, FON_PUT_ADD, ffi_fon_collection_put_bool, value ? 1 : 0);
    }

    addString(key, value) {
        return putBytes(this, key, FON_PUT_ADD, ffi_fon_collection_put_string, stringBytes(value, 'value'));
    }

    addRaw(key, value) {
        return putBytes(this, key, FON_PUT_ADD, ffi_fon_collection_put_raw, rawBytes(value));
    }

    addByteArray(key, values) {
        return putArray(this, key, FON_PUT_ADD, ffi_fon_collection_put_byte_array, toTypedArray(Uint8Array, values, (v) => checkedInt(v, 0, 0xFF, 'byte'), 'byte array'));
    }

    addShortArray(key, values) {
        return putArray(this, key, FON_PUT_ADD, ffi_fon_collection_put_short_array, toTypedArray(Int16Array, values, (v) => checkedInt(v, -0x8000, 0x7FFF, 'short'), 'short array'));
    }

    /** @param {string} key @param {number[]} values @returns {this} */
    addIntArray(key, values) {
        return putArray(this, key, FON_PUT_ADD, ffi_fon_collection_put_int_array, toTypedArray(Int32Array, values, (v) => checkedInt(v, I32_MIN, I32_MAX, 'int'), 'int array'));
    }

    addUIntArray(key, values) {
        return putArray(this, key, FON_PUT_ADD, ffi_fon_collection_put_uint_array, toTypedArray(Uint32Array, values, (v) => checkedInt(v, 0, 0xFFFFFFFF, 'uint'), 'uint array'));
    }

    addLongArray(key, values) {
        return putArray(this, key, FON_PUT_ADD, ffi_fon_collection_put_long_array, toPlainArray(values, (v) => checkedBigInt(v, I64_MIN, I64_MAX, 'long'), 'long array'));
    }

    addULongArray(key, values) {
        return putArray(this, key, FON_PUT_ADD, ffi_fon_collection_put_ulong_array, toPlainArray(values, (v) => checkedBigInt(v, 0n, U64_MAX, 'ulong'), 'ulong array'));
    }

    /** @param {string} key @param {number[]} values @returns {this} */
    addFloatArray(key, values) {
        return putArray(this, key, FON_PUT_ADD, ffi_fon_collection_put_float_array, toTypedArray(Float32Array, values, (v) => checkedNumber(v, 'float'), 'float array'));
    }

    addDoubleArray(key, values) {
        return putArray(this, key, FON_PUT_ADD, ffi_fon_collection_put_double_array, toTypedArray(Float64Array, values, (v) => checkedNumber(v, 'double'), 'double array'));
    }

    addBoolArray(key, values) {
        return putArray(this, key, FON_PUT_ADD, ffi_fon_collection_put_bool_array, toTypedArray(Uint8Array, values, (v) => (v ? 1 : 0), 'bool array'));
    }

    addStringArray(key, values) {
        return putStringArray(this, key, FON_PUT_ADD, values);
    }

    /**
     * Adds a nested collection under key. OWNERSHIP TRANSFER: on success `child` becomes unusable.
     * @param {string} key
     * @param {FonCollection} child Owned, live collection.
     * @returns {this}
     */
    addCollection(key, child) {
        return putChild(this, key, FON_PUT_ADD, child);
    }

    /**
     * Adds an array of nested collections under key. OWNERSHIP TRANSFER: on success every element
     * becomes unusable.
     * @param {string} key
     * @param {FonCollection[]} children Owned, live collections; each may appear once.
     * @returns {this}
     */
    addCollectionArray(key, children) {
        return putChildren(this, key, FON_PUT_ADD, children);
    }

    // -- Set (upsert: replaces the field, whatever its type was) --

    setByte(key, value) {
        return putScalar(this, key, FON_PUT_UPSERT, ffi_fon_collection_put_byte, checkedInt(value, 0, 0xFF, 'byte'));
    }

    setShort(key, value) {
        return putScalar(this, key, FON_PUT_UPSERT, ffi_fon_collection_put_short, checkedInt(value, -0x8000, 0x7FFF, 'short'));
    }

    setInt(key, value) {
        return putScalar(this, key, FON_PUT_UPSERT, ffi_fon_collection_put_int, checkedInt(value, I32_MIN, I32_MAX, 'int'));
    }

    setUInt(key, value) {
        return putScalar(this, key, FON_PUT_UPSERT, ffi_fon_collection_put_uint, checkedInt(value, 0, 0xFFFFFFFF, 'uint'));
    }

    setLong(key, value) {
        return putScalar(this, key, FON_PUT_UPSERT, ffi_fon_collection_put_long, checkedBigInt(value, I64_MIN, I64_MAX, 'long'));
    }

    setULong(key, value) {
        return putScalar(this, key, FON_PUT_UPSERT, ffi_fon_collection_put_ulong, checkedBigInt(value, 0n, U64_MAX, 'ulong'));
    }

    setFloat(key, value) {
        return putScalar(this, key, FON_PUT_UPSERT, ffi_fon_collection_put_float, checkedNumber(value, 'float'));
    }

    setDouble(key, value) {
        return putScalar(this, key, FON_PUT_UPSERT, ffi_fon_collection_put_double, checkedNumber(value, 'double'));
    }

    setBool(key, value) {
        return putScalar(this, key, FON_PUT_UPSERT, ffi_fon_collection_put_bool, value ? 1 : 0);
    }

    setString(key, value) {
        return putBytes(this, key, FON_PUT_UPSERT, ffi_fon_collection_put_string, stringBytes(value, 'value'));
    }

    setRaw(key, value) {
        return putBytes(this, key, FON_PUT_UPSERT, ffi_fon_collection_put_raw, rawBytes(value));
    }

    setByteArray(key, values) {
        return putArray(this, key, FON_PUT_UPSERT, ffi_fon_collection_put_byte_array, toTypedArray(Uint8Array, values, (v) => checkedInt(v, 0, 0xFF, 'byte'), 'byte array'));
    }

    setShortArray(key, values) {
        return putArray(this, key, FON_PUT_UPSERT, ffi_fon_collection_put_short_array, toTypedArray(Int16Array, values, (v) => checkedInt(v, -0x8000, 0x7FFF, 'short'), 'short array'));
    }

    setIntArray(key, values) {
        return putArray(this, key, FON_PUT_UPSERT, ffi_fon_collection_put_int_array, toTypedArray(Int32Array, values, (v) => checkedInt(v, I32_MIN, I32_MAX, 'int'), 'int array'));
    }

    setUIntArray(key, values) {
        return putArray(this, key, FON_PUT_UPSERT, ffi_fon_collection_put_uint_array, toTypedArray(Uint32Array, values, (v) => checkedInt(v, 0, 0xFFFFFFFF, 'uint'), 'uint array'));
    }

    setLongArray(key, values) {
        return putArray(this, key, FON_PUT_UPSERT, ffi_fon_collection_put_long_array, toPlainArray(values, (v) => checkedBigInt(v, I64_MIN, I64_MAX, 'long'), 'long array'));
    }

    setULongArray(key, values) {
        return putArray(this, key, FON_PUT_UPSERT, ffi_fon_collection_put_ulong_array, toPlainArray(values, (v) => checkedBigInt(v, 0n, U64_MAX, 'ulong'), 'ulong array'));
    }

    setFloatArray(key, values) {
        return putArray(this, key, FON_PUT_UPSERT, ffi_fon_collection_put_float_array, toTypedArray(Float32Array, values, (v) => checkedNumber(v, 'float'), 'float array'));
    }

    setDoubleArray(key, values) {
        return putArray(this, key, FON_PUT_UPSERT, ffi_fon_collection_put_double_array, toTypedArray(Float64Array, values, (v) => checkedNumber(v, 'double'), 'double array'));
    }

    setBoolArray(key, values) {
        return putArray(this, key, FON_PUT_UPSERT, ffi_fon_collection_put_bool_array, toTypedArray(Uint8Array, values, (v) => (v ? 1 : 0), 'bool array'));
    }

    setStringArray(key, values) {
        return putStringArray(this, key, FON_PUT_UPSERT, values);
    }

    setCollection(key, child) {
        return putChild(this, key, FON_PUT_UPSERT, child);
    }

    setCollectionArray(key, children) {
        return putChildren(this, key, FON_PUT_UPSERT, children);
    }

    // -- Get (typed reads: NOT_FOUND for an absent key, TYPE_MISMATCH for another type) --

    getByte(key) {
        return getScalar(this, key, ffi_fon_collection_get_byte, 0);
    }

    getShort(key) {
        return getScalar(this, key, ffi_fon_collection_get_short, 0);
    }

    getInt(key) {
        return getScalar(this, key, ffi_fon_collection_get_int, 0);
    }

    getUInt(key) {
        return getScalar(this, key, ffi_fon_collection_get_uint, 0);
    }

    /** @returns {bigint} */
    getLong(key) {
        return BigInt(getScalar(this, key, ffi_fon_collection_get_long, 0n));
    }

    /** @returns {bigint} */
    getULong(key) {
        return BigInt(getScalar(this, key, ffi_fon_collection_get_ulong, 0n));
    }

    getFloat(key) {
        return getScalar(this, key, ffi_fon_collection_get_float, 0);
    }

    getDouble(key) {
        return getScalar(this, key, ffi_fon_collection_get_double, 0);
    }

    getBool(key) {
        return getScalar(this, key, ffi_fon_collection_get_bool, 0) !== 0;
    }

    getString(key) {
        return getBytes(this, key, ffi_fon_collection_get_string).toString('utf8');
    }

    /** @returns {Buffer} */
    getRaw(key) {
        return getBytes(this, key, ffi_fon_collection_get_raw);
    }

    getByteArray(key) {
        return getTypedArray(this, key, ffi_fon_collection_get_byte_array, Uint8Array);
    }

    getShortArray(key) {
        return getTypedArray(this, key, ffi_fon_collection_get_short_array, Int16Array);
    }

    /** @returns {number[]} */
    getIntArray(key) {
        return getTypedArray(this, key, ffi_fon_collection_get_int_array, Int32Array);
    }

    getUIntArray(key) {
        return getTypedArray(this, key, ffi_fon_collection_get_uint_array, Uint32Array);
    }

    /** @returns {bigint[]} */
    getLongArray(key) {
        return getWideArray(this, key, ffi_fon_collection_get_long_array, 'int64');
    }

    /** @returns {bigint[]} */
    getULongArray(key) {
        return getWideArray(this, key, ffi_fon_collection_get_ulong_array, 'uint64');
    }

    /** @returns {number[]} */
    getFloatArray(key) {
        return getTypedArray(this, key, ffi_fon_collection_get_float_array, Float32Array);
    }

    getDoubleArray(key) {
        return getTypedArray(this, key, ffi_fon_collection_get_double_array, Float64Array);
    }

    /** @returns {boolean[]} */
    getBoolArray(key) {
        return getTypedArray(this, key, ffi_fon_collection_get_bool_array, Uint8Array).map((v) => v !== 0);
    }

    /** @returns {string[]} */
    getStringArray(key) {
        return getStringArray(this, key);
    }

    /**
     * Returns a nested VIEW of the collection stored under key. Do not free it; it stays valid
     * until the tree it belongs to changes, and then raises STALE_VIEW.
     * @returns {FonCollection}
     */
    getCollection(key) {
        const handle = resolveHandle(this);
        const keyBuf = stringBytes(key, 'key');
        const err = makeError();
        const child = ffi_fon_collection_get_collection(handle, keyBuf, BigInt(keyBuf.length), err);
        if (!child) {
            throw nativeError(err.readInt32LE(0), err);
        }
        return openNestedView(this, child);
    }

    /**
     * Returns nested VIEWS of the collections stored under key (one size query and one fill).
     * @returns {FonCollection[]}
     */
    getCollectionArray(key) {
        return getCollectionArray(this, key);
    }

    /**
     * Returns the kind of a field, or null when the key is absent.
     * @param {string} key
     * @returns {{type: string, array: boolean}|null}
     */
    kind(key) {
        const handle = resolveHandle(this);
        const keyBuf = stringBytes(key, 'key');
        const code = ffi_fon_collection_kind_of(handle, keyBuf, BigInt(keyBuf.length));
        if (code < 0) {
            return null;
        }
        return decodeKind(code);
    }

    /** @returns {boolean} */
    has(key) {
        const handle = resolveHandle(this);
        const keyBuf = stringBytes(key, 'key');
        return ffi_fon_collection_kind_of(handle, keyBuf, BigInt(keyBuf.length)) >= 0;
    }

    /**
     * Removes a field.
     * @returns {boolean} true if the field existed.
     */
    remove(key) {
        const handle = resolveHandle(this);
        const keyBuf = stringBytes(key, 'key');
        const removed = ffi_fon_collection_remove(handle, keyBuf, BigInt(keyBuf.length)) === 1;
        if (removed) {
            noteMutation(this);
        }
        return removed;
    }

    /** @returns {string[]} keys in insertion order. */
    keys() {
        return readEntries(this).map((entry) => entry.key);
    }

    /**
     * Dynamic read: returns the value under key according to its kind.
     * @returns {*}
     */
    get(key) {
        const kind = this.kind(key);
        if (kind === null) {
            throw new FonError('NOT_FOUND', `key '${key}' not found`);
        }
        const name = kind.array ? DYNAMIC_ARRAY_GETTERS[kind.type] : DYNAMIC_GETTERS[kind.type];
        return this[name](key);
    }

    /**
     * Returns an independent owned deep copy (also for views).
     * @returns {FonCollection}
     */
    clone() {
        const handle = resolveHandle(this);
        const err = makeError();
        const copy = ffi_fon_collection_clone(handle, err);
        if (!copy) {
            throw nativeError(err.readInt32LE(0), err);
        }
        return wrapOwnedCollection(copy);
    }

    /** Serializes this collection to a single FON line. */
    serialize() {
        const handle = resolveHandle(this);
        const out = [null];
        const outLen = [0n];
        const err = makeError();
        const rc = ffi_fon_serialize_collection(handle, out, outLen, err);
        ensureOk(rc, err);
        return takeNativeBytes(out[0], outLen[0]).toString('utf8');
    }

    /**
     * Parses a single FON line into a new owned collection.
     * @param {string} line
     * @returns {FonCollection}
     */
    static deserialize(line) {
        const bytes = stringBytes(line, 'line');
        const err = makeError();
        const handle = ffi_fon_deserialize_collection(bytes, BigInt(bytes.length), err);
        if (!handle) {
            throw nativeError(err.readInt32LE(0), err);
        }
        return wrapOwnedCollection(handle);
    }
}

const DYNAMIC_GETTERS = {
    byte: 'getByte',
    short: 'getShort',
    int: 'getInt',
    uint: 'getUInt',
    long: 'getLong',
    ulong: 'getULong',
    float: 'getFloat',
    double: 'getDouble',
    bool: 'getBool',
    string: 'getString',
    raw: 'getRaw',
    object: 'getCollection',
};

const DYNAMIC_ARRAY_GETTERS = {
    byte: 'getByteArray',
    short: 'getShortArray',
    int: 'getIntArray',
    uint: 'getUIntArray',
    long: 'getLongArray',
    ulong: 'getULongArray',
    float: 'getFloatArray',
    double: 'getDoubleArray',
    bool: 'getBoolArray',
    string: 'getStringArray',
    object: 'getCollectionArray',
};

// ==================== FonDump ====================

/**
 * A FON dump: an ordered map from numeric record id to FonCollection.
 *
 * Ids are stable in memory and renumber (0..n-1) when serialized. A dump owns its records; the
 * collections returned by get() and enumeration are record views that keep this dump alive.
 */
class FonDump {
    /**
     * Creates an empty owned dump.
     */
    constructor() {
        const handle = ffi_fon_dump_create();
        if (!handle) {
            throw new Error('fon_dump_create returned null');
        }
        initOwnedDump(this, handle);
    }

    /** Number of live records. */
    get size() {
        return Number(ffi_fon_dump_size(dumpStateOf(this).handle));
    }

    /** True when the dump has been freed or transferred. */
    get disposed() {
        return stateOf(this).disposed;
    }

    /** Throws if the dump has been freed. */
    assertAlive() {
        dumpStateOf(this);
    }

    /** Frees the dump and invalidates every view of it. No-op if already freed. */
    free() {
        const st = stateOf(this);
        if (st.disposed) {
            return;
        }
        ffi_fon_dump_free(st.handle);
        st.disposed = true;
        releaseRegistry.unregister(this);
    }

    [disposeKey]() {
        this.free();
    }

    /**
     * Adds a record; the id must not exist. OWNERSHIP TRANSFER: on success `col` becomes unusable.
     * @param {number|bigint} id
     * @param {FonCollection} col
     * @returns {this}
     */
    add(id, col) {
        return putRecord(this, id, FON_PUT_ADD, col);
    }

    /**
     * Adds or replaces a record (upsert). OWNERSHIP TRANSFER as for add().
     * @returns {this}
     */
    set(id, col) {
        return putRecord(this, id, FON_PUT_UPSERT, col);
    }

    /**
     * Replaces an existing record; the id must exist (NOT_FOUND otherwise). OWNERSHIP TRANSFER as
     * for add().
     * @returns {this}
     */
    replace(id, col) {
        return putRecord(this, id, FON_PUT_SET, col);
    }

    /**
     * Removes a record.
     * @returns {boolean} true if the record existed.
     */
    remove(id) {
        const st = dumpStateOf(this);
        const removed = ffi_fon_dump_remove(st.handle, toUint64(id)) === 1;
        // Bumped even when nothing was removed: the core may promote the store before it checks presence.
        st.version += 1;
        return removed;
    }

    /**
     * Removes several records. Absent and duplicate ids are ignored.
     * @param {Iterable<number|bigint>} ids
     * @returns {number} number of records actually removed.
     */
    removeMany(ids) {
        const st = dumpStateOf(this);
        const list = Array.from(ids, (id) => toUint64(id));
        if (list.length === 0) {
            return 0;
        }
        const removed = Number(ffi_fon_dump_remove_many(st.handle, list, BigInt(list.length)));
        // Bumped even when nothing was removed: the core may promote the store before it checks presence.
        st.version += 1;
        return removed;
    }

    /** @returns {boolean} */
    has(id) {
        const st = dumpStateOf(this);
        return Boolean(ffi_fon_dump_get(st.handle, toUint64(id)));
    }

    /**
     * Live ids in ascending order. Ids above Number.MAX_SAFE_INTEGER are returned as bigint.
     * @returns {Array<number|bigint>}
     */
    ids() {
        return readDumpIds(this).map(toSafeId);
    }

    /**
     * Returns a record VIEW, or null when the id is absent.
     * @param {number|bigint} id
     * @returns {FonCollection|null}
     */
    get(id) {
        return openRecordView(this, toUint64(id));
    }

    /**
     * Yields [id, view] pairs in ascending id order. One ids call plus one lookup per record.
     * @returns {IterableIterator<[number|bigint, FonCollection]>}
     */
    *entries() {
        const ids = readDumpIds(this);
        for (const id of ids) {
            const view = openRecordView(this, id);
            if (view !== null) {
                yield [toSafeId(id), view];
            }
        }
    }

    [Symbol.iterator]() {
        return this.entries();
    }

    /**
     * Serializes the whole dump to a multi-line FON string.
     * @param {number} [maxThreads=0] 0 uses all cores; a positive value caps the worker threads.
     * @returns {string}
     */
    serialize(maxThreads = 0) {
        const st = dumpStateOf(this);
        const out = [null];
        const outLen = [0n];
        const err = makeError();
        const rc = ffi_fon_serialize_dump(st.handle, toThreads(maxThreads), out, outLen, err);
        ensureOk(rc, err);
        return takeNativeBytes(out[0], outLen[0]).toString('utf8');
    }

    /**
     * Writes the dump to a file.
     * @param {string} filePath
     * @param {number} [maxThreads=0]
     */
    serializeToFile(filePath, maxThreads = 0) {
        const st = dumpStateOf(this);
        const pathBuf = stringBytes(filePath, 'filePath');
        const err = makeError();
        const rc = ffi_fon_serialize_to_file(st.handle, pathBuf, BigInt(pathBuf.length), toThreads(maxThreads), err);
        ensureOk(rc, err);
    }

    /**
     * Parses a multi-line FON string into a new owned dump.
     * @param {string} text
     * @param {number} [maxThreads=0]
     * @returns {FonDump}
     */
    static deserialize(text, maxThreads = 0) {
        const bytes = stringBytes(text, 'text');
        const err = makeError();
        const handle = ffi_fon_deserialize_dump(bytes, BigInt(bytes.length), toThreads(maxThreads), err);
        if (!handle) {
            throw nativeError(err.readInt32LE(0), err);
        }
        return wrapOwnedDump(handle);
    }

    /**
     * Reads a dump from a file into a new owned dump.
     * @param {string} filePath
     * @param {number} [maxThreads=0]
     * @returns {FonDump}
     */
    static deserializeFromFile(filePath, maxThreads = 0) {
        const pathBuf = stringBytes(filePath, 'filePath');
        const err = makeError();
        const handle = ffi_fon_deserialize_from_file(pathBuf, BigInt(pathBuf.length), toThreads(maxThreads), err);
        if (!handle) {
            throw nativeError(err.readInt32LE(0), err);
        }
        return wrapOwnedDump(handle);
    }
}

// ==================== MODULE FUNCTIONS ====================

/**
 * Returns the native library version string (e.g. "0.4.0").
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
 * Sets the maximum recursion depth for deserialization (global setting, minimum 1).
 * @param {number} depth
 */
function setMaxDepth(depth) {
    ffi_fon_set_max_depth(checkedInt(depth, I32_MIN, I32_MAX, 'depth'));
}

/**
 * Reads a FON dump directly from a file into a new owned dump.
 * @param {string} filePath
 * @param {number} [maxThreads=0]
 * @returns {FonDump}
 */
function deserializeDumpFromFile(filePath, maxThreads = 0) {
    return FonDump.deserializeFromFile(filePath, maxThreads);
}

export { FonCollection, FonDump, FonError, nativeVersion, setRawUnpack, setMaxDepth, deserializeDumpFromFile };
