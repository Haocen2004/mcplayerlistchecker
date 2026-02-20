import { MongoClient, Db } from 'mongodb';

export interface LogEntry {
    type: 'join' | 'leave';
    uuid: string;
    username: string;
    server: string;
    timestamp: Date;
}

export interface StatusHistory {
    tps: string;
    mspt: string;
    playerCount: number;
    server: string;
    timestamp: Date;
}

let db: Db | null = null;
let client: MongoClient | null = null;

export async function initDb(uri: string = 'mongodb://localhost:27017', dbName: string = 'mc_checker') {
    try {
        client = new MongoClient(uri);
        await client.connect();
        db = client.db(dbName);
        console.log(`[DB] Connected to MongoDB: ${dbName}`);

        // Ensure indexes
        await db.collection('logs').createIndex({ timestamp: -1 });
        await db.collection('history').createIndex({ timestamp: -1 });
    } catch (e) {
        console.error(`[DB] Failed to connect to MongoDB: ${e}`);
        throw e;
    }
}

export async function saveLog(entry: Omit<LogEntry, 'timestamp'>) {
    if (!db) return;
    try {
        await db.collection('logs').insertOne({
            ...entry,
            timestamp: new Date()
        });
    } catch (e) {
        console.error(`[DB] Error saving log: ${e}`);
    }
}

export async function saveHistory(history: Omit<StatusHistory, 'timestamp'>) {
    if (!db) return;
    try {
        await db.collection('history').insertOne({
            ...history,
            timestamp: new Date()
        });
    } catch (e) {
        console.error(`[DB] Error saving history: ${e}`);
    }
}

export function getDb() {
    return db;
}
