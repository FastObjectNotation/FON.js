// Type declarations for FastObjectNotation

/**
 * Wraps a heap-allocated FonCollection handle.
 *
 * Ownership rules:
 * - Call `free()` when you own the collection and are done with it.
 * - After `addCollection`, `addCollectionArray`, or `FonDump.add`, the handle is
 *   transferred and `disposed` is set to `true`. Do not use or free it afterwards.
 * - Handles returned by `getCollection`, `getCollectionArray`, and `FonDump.get`
 *   are BORROWED — do NOT call `free()` on them.
 */
export class FonCollection {
    /** True when ownership of this handle has been transferred to a parent. */
    readonly disposed: boolean;

    constructor();

    /** Throws if the handle has been transferred (disposed === true). */
    assertAlive(): void;

    /** Frees the native handle. No-op if already disposed. */
    free(): void;

    /** Number of key-value entries stored in the collection. */
    readonly size: number;

    // ---- Add methods ----

    addInt(key: string, value: number): this;
    addLong(key: string, value: bigint | number): this;
    addDouble(key: string, value: number): this;
    addBool(key: string, value: boolean): this;
    addString(key: string, value: string): this;

    /**
     * Stores an array of 32-bit integers under key.
     * Values are truncated to i32 range before the FFI call.
     */
    addIntArray(key: string, values: number[]): this;

    /**
     * Stores an array of 32-bit floats under key.
     * Values are truncated to f32 precision before the FFI call.
     */
    addFloatArray(key: string, values: number[]): this;

    /**
     * Adds a nested collection under key.
     * OWNERSHIP TRANSFER: child.disposed is set to true after this call.
     */
    addCollection(key: string, child: FonCollection): this;

    /**
     * Adds an array of nested collections under key.
     * OWNERSHIP TRANSFER: every element's disposed is set to true after this call.
     */
    addCollectionArray(key: string, children: FonCollection[]): this;

    // ---- Get methods ----

    getInt(key: string): number;
    getLong(key: string): bigint;
    getDouble(key: string): number;
    getBool(key: string): boolean;
    getString(key: string): string;

    /** Returns an array of 32-bit integers. Uses the two-call size-query pattern. */
    getIntArray(key: string): number[];

    /** Returns an array of 32-bit floats. Uses the two-call size-query pattern. */
    getFloatArray(key: string): number[];

    /**
     * Returns a BORROWED FonCollection stored under key.
     * Do NOT call free() on the returned handle.
     */
    getCollection(key: string): FonCollection;

    /**
     * Returns an array of BORROWED FonCollections stored under key.
     * Do NOT call free() on any of the returned handles.
     * Uses the two-call size-query pattern.
     */
    getCollectionArray(key: string): FonCollection[];

    // ---- Serialization ----

    /** Serializes this collection to a single FON line string. */
    serialize(): string;

    /** Parses a single FON line into a new FonCollection (caller owns the result). */
    static deserialize(line: string): FonCollection;
}

/**
 * Wraps a heap-allocated FonDump handle (ordered id → FonCollection map).
 */
export class FonDump {
    /** True when the dump has been freed. */
    readonly disposed: boolean;

    constructor();

    /** Throws if the dump has been freed. */
    assertAlive(): void;

    /** Frees the native handle. No-op if already disposed. */
    free(): void;

    /** Number of collections stored in the dump. */
    readonly size: number;

    /**
     * Adds a collection to the dump under the given numeric id.
     * OWNERSHIP TRANSFER: col.disposed is set to true after this call.
     */
    add(id: number | bigint, col: FonCollection): this;

    /**
     * Returns a BORROWED FonCollection at the given index.
     * Do NOT call free() on the returned handle.
     * Returns null when the index is out of range.
     */
    get(index: number | bigint): FonCollection | null;

    /** Serializes the entire dump to a multi-line FON string. */
    serialize(maxThreads?: number): string;

    /** Writes the dump directly to a file at the given path. */
    serializeToFile(filePath: string, maxThreads?: number): void;

    /** Parses a multi-line FON string into a new FonDump (caller owns the result). */
    static deserialize(text: string, maxThreads?: number): FonDump;
}

// ---- Exported functions ----

/** Returns the native library version string (e.g. "0.3.0"). */
export function nativeVersion(): string;

/** Enables or disables raw unpack mode for deserialization (global setting). */
export function setRawUnpack(value: boolean): void;

/** Sets the maximum recursion depth for deserialization (global setting, minimum 1). */
export function setMaxDepth(depth: number): void;

/**
 * Reads a FON dump directly from a file (caller owns the result).
 * @param filePath Absolute or relative file path.
 * @param maxThreads Number of threads to use (0 = automatic).
 */
export function deserializeDumpFromFile(filePath: string, maxThreads?: number): FonDump;
