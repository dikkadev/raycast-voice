declare module "node-record-lpcm16" {
    import { Readable } from "stream";

    export interface RecordOptions {
        sampleRate?: number;
        channels?: number;
        threshold?: number;
        silence?: string;
        recorder?: string;
        device?: string | null;
        endOnSilence?: boolean;
    }

    export interface Recording {
        stream(): Readable | null;
        stop(): void;
        pause(): void;
        resume(): void;
    }

    export function record(options?: RecordOptions): Recording;

    export default { record };
}
