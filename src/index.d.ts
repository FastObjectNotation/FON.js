// Type declarations for fastobjectnotation

/** Kind names used by FonCollection.kind(). */
export type FonTypeName =
    | 'byte'
    | 'short'
    | 'int'
    | 'uint'
    | 'long'
    | 'ulong'
    | 'float'
    | 'double'
    | 'bool'
    | 'string'
    | 'raw'
    | 'object';

/** Kind of a field: its type and whether it is an array. */
export interface FonKind {
    readonly type: FonTypeName;
    readonly array: boolean;
}

/** Symbolic result code carried by FonError. */
export type FonErrorCode =
    | 'FILE_NOT_FOUND'
    | 'PARSE_FAILED'
    | 'WRITE_FAILED'
    | 'INVALID_ARGUMENT'
    | 'BUFFER_TOO_SMALL'
    | 'NOT_FOUND'
    | 'TYPE_MISMATCH'
    | 'ALREADY_EXISTS'
    | 'STALE_VIEW'
    | 'UNKNOWN';

/**
 * Error raised for native result codes. `message` is the native message and names the key or id.
 *
 * - NOT_FOUND: key or id is absent.
 * - TYPE_MISMATCH: the key holds another type.
 * - ALREADY_EXISTS: add() on an existing key or id.
 * - STALE_VIEW: a view outlived the record or nested collection it refers to.
 * - INVALID_ARGUMENT: e.g. a view passed where an owned collection is required.
 */
export class FonError extends Error {
    readonly code: FonErrorCode;

    constructor(code: FonErrorCode, message: string);
}

/**
 * A FON collection: an ordered set of typed key/value fields.
 *
 * Owned collections (constructor, clone(), deserialize()) must be freed with free(), or are
 * released when they are transferred into a FonDump or another collection (after which they are
 * unusable). Collections returned by get(), getCollection(), getCollectionArray() and
 * FonDump.get() are views: they never own memory, free() on them does nothing, and they raise
 * STALE_VIEW when the data they refer to changes.
 */
export class FonCollection {
    /** True when this object was freed or transferred, or (for a view) its owner was. */
    readonly disposed: boolean;

    constructor();

    /** Throws if this object cannot be used (freed, transferred, or a stale view). */
    assertAlive(): void;

    /** Frees an owned collection. No-op if already freed or transferred, and on views. */
    free(): void;

    /** Disposes like free(). */
    [Symbol.dispose](): void;

    /** Number of key/value fields. */
    readonly size: number;

    // ---- Add (key must not exist; FonError ALREADY_EXISTS otherwise) ----

    addByte(key: string, value: number): this;
    addShort(key: string, value: number): this;
    addInt(key: string, value: number): this;
    addUInt(key: string, value: number): this;
    addLong(key: string, value: bigint | number): this;
    addULong(key: string, value: bigint | number): this;
    addFloat(key: string, value: number): this;
    addDouble(key: string, value: number): this;
    addBool(key: string, value: boolean): this;
    addString(key: string, value: string): this;
    /** Stores bytes. Accepts Uint8Array or Buffer. */
    addRaw(key: string, value: Uint8Array): this;

    addByteArray(key: string, values: ArrayLike<number>): this;
    addShortArray(key: string, values: ArrayLike<number>): this;
    addIntArray(key: string, values: ArrayLike<number>): this;
    addUIntArray(key: string, values: ArrayLike<number>): this;
    addLongArray(key: string, values: ReadonlyArray<bigint | number>): this;
    addULongArray(key: string, values: ReadonlyArray<bigint | number>): this;
    addFloatArray(key: string, values: ArrayLike<number>): this;
    addDoubleArray(key: string, values: ArrayLike<number>): this;
    addBoolArray(key: string, values: ReadonlyArray<boolean>): this;
    addStringArray(key: string, values: ReadonlyArray<string>): this;

    /**
     * Adds a nested collection under key.
     * OWNERSHIP TRANSFER: on success `child` is unusable; on failure the caller keeps it.
     * Passing a view throws FonError INVALID_ARGUMENT (call clone() first).
     */
    addCollection(key: string, child: FonCollection): this;

    /**
     * Adds an array of nested collections under key.
     * OWNERSHIP TRANSFER: on success every element is unusable; each may appear only once.
     */
    addCollectionArray(key: string, children: ReadonlyArray<FonCollection>): this;

    // ---- Set (upsert: replaces the field, whatever its previous type) ----

    setByte(key: string, value: number): this;
    setShort(key: string, value: number): this;
    setInt(key: string, value: number): this;
    setUInt(key: string, value: number): this;
    setLong(key: string, value: bigint | number): this;
    setULong(key: string, value: bigint | number): this;
    setFloat(key: string, value: number): this;
    setDouble(key: string, value: number): this;
    setBool(key: string, value: boolean): this;
    setString(key: string, value: string): this;
    setRaw(key: string, value: Uint8Array): this;

    setByteArray(key: string, values: ArrayLike<number>): this;
    setShortArray(key: string, values: ArrayLike<number>): this;
    setIntArray(key: string, values: ArrayLike<number>): this;
    setUIntArray(key: string, values: ArrayLike<number>): this;
    setLongArray(key: string, values: ReadonlyArray<bigint | number>): this;
    setULongArray(key: string, values: ReadonlyArray<bigint | number>): this;
    setFloatArray(key: string, values: ArrayLike<number>): this;
    setDoubleArray(key: string, values: ArrayLike<number>): this;
    setBoolArray(key: string, values: ReadonlyArray<boolean>): this;
    setStringArray(key: string, values: ReadonlyArray<string>): this;

    /** Upsert of a nested collection. OWNERSHIP TRANSFER as for addCollection(). */
    setCollection(key: string, child: FonCollection): this;

    /** Upsert of an array of nested collections. OWNERSHIP TRANSFER as for addCollectionArray(). */
    setCollectionArray(key: string, children: ReadonlyArray<FonCollection>): this;

    // ---- Get (typed reads; NOT_FOUND for an absent key, TYPE_MISMATCH for another type) ----

    getByte(key: string): number;
    getShort(key: string): number;
    getInt(key: string): number;
    getUInt(key: string): number;
    getLong(key: string): bigint;
    getULong(key: string): bigint;
    getFloat(key: string): number;
    getDouble(key: string): number;
    getBool(key: string): boolean;
    getString(key: string): string;
    /** Returns a Buffer with the stored bytes. */
    getRaw(key: string): Buffer;

    getByteArray(key: string): number[];
    getShortArray(key: string): number[];
    getIntArray(key: string): number[];
    getUIntArray(key: string): number[];
    getLongArray(key: string): bigint[];
    getULongArray(key: string): bigint[];
    getFloatArray(key: string): number[];
    getDoubleArray(key: string): number[];
    getBoolArray(key: string): boolean[];
    getStringArray(key: string): string[];

    /**
     * Returns a nested VIEW (do not free it). It raises STALE_VIEW after the tree it belongs to
     * changes, and FonError NOT_FOUND / TYPE_MISMATCH like the other typed getters.
     */
    getCollection(key: string): FonCollection;

    /** Returns nested VIEWS (do not free them). */
    getCollectionArray(key: string): FonCollection[];

    // ---- Introspection and mutation ----

    /** Returns the kind of the field, or null when the key is absent. */
    kind(key: string): FonKind | null;

    /** True when the key is present. */
    has(key: string): boolean;

    /** Removes a field. Returns true if it existed. */
    remove(key: string): boolean;

    /** Keys in insertion order. */
    keys(): string[];

    /** Dynamic read: the value under key, typed according to its kind. Throws NOT_FOUND. */
    get(key: string): unknown;

    /** Independent owned deep copy (also of a view). */
    clone(): FonCollection;

    // ---- Serialization ----

    /** Serializes this collection to a single FON line string. */
    serialize(): string;

    /** Parses a single FON line into a new owned collection. */
    static deserialize(line: string): FonCollection;
}

/**
 * A FON dump: an ordered map from numeric record id to FonCollection.
 *
 * Ids are stable in memory and renumber (0..n-1) when serialized. get() and enumeration return
 * record views that keep the dump alive and raise STALE_VIEW when their record is removed or
 * replaced. Freeing the dump invalidates every view of it.
 */
export class FonDump {
    /** True when the dump has been freed. */
    readonly disposed: boolean;

    constructor();

    /** Throws if the dump has been freed. */
    assertAlive(): void;

    /** Frees the dump. No-op if already freed. */
    free(): void;

    /** Disposes like free(). */
    [Symbol.dispose](): void;

    /** Number of live records. */
    readonly size: number;

    /**
     * Adds a record; the id must not exist (FonError ALREADY_EXISTS).
     * OWNERSHIP TRANSFER: on success `col` is unusable; on failure the caller keeps it.
     */
    add(id: number | bigint, col: FonCollection): this;

    /** Adds or replaces a record. OWNERSHIP TRANSFER as for add(). */
    set(id: number | bigint, col: FonCollection): this;

    /** Replaces an existing record; the id must exist (FonError NOT_FOUND). OWNERSHIP TRANSFER as for add(). */
    replace(id: number | bigint, col: FonCollection): this;

    /** Removes a record. Returns true if it existed. */
    remove(id: number | bigint): boolean;

    /** Removes several records; absent and duplicate ids are ignored. Returns the number removed. */
    removeMany(ids: Iterable<number | bigint>): number;

    /** True when the id is present. */
    has(id: number | bigint): boolean;

    /** Live ids in ascending order. Ids above Number.MAX_SAFE_INTEGER are returned as bigint. */
    ids(): Array<number | bigint>;

    /** Returns a record VIEW (do not free it), or null when the id is absent. */
    get(id: number | bigint): FonCollection | null;

    /** Yields [id, view] pairs in ascending id order. */
    entries(): IterableIterator<[number | bigint, FonCollection]>;

    [Symbol.iterator](): IterableIterator<[number | bigint, FonCollection]>;

    /**
     * Serializes the whole dump to a multi-line FON string.
     * @param maxThreads 0 uses all cores; a positive value caps the worker threads.
     */
    serialize(maxThreads?: number): string;

    /** Writes the dump to a file. */
    serializeToFile(filePath: string, maxThreads?: number): void;

    /** Parses a multi-line FON string into a new owned dump. */
    static deserialize(text: string, maxThreads?: number): FonDump;

    /** Reads a dump from a file into a new owned dump. */
    static deserializeFromFile(filePath: string, maxThreads?: number): FonDump;
}

// ---- Exported functions ----

/** Returns the native library version string (e.g. "0.4.0"). */
export function nativeVersion(): string;

/** Enables or disables raw unpack mode for deserialization (global setting). */
export function setRawUnpack(value: boolean): void;

/** Sets the maximum recursion depth for deserialization (global setting, minimum 1). */
export function setMaxDepth(depth: number): void;

/**
 * Reads a FON dump directly from a file into a new owned dump.
 * @param filePath Absolute or relative file path.
 * @param maxThreads 0 uses all cores; a positive value caps the worker threads.
 */
export function deserializeDumpFromFile(filePath: string, maxThreads?: number): FonDump;
