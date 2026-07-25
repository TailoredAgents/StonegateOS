import {
  fetchRemoteImage,
  type RemoteMediaProvider,
} from "@/lib/appointment-media";
import {
  normalizeAppointmentImage,
  type NormalizedAppointmentImage,
} from "@/lib/appointment-image";

export type AppointmentMediaPreflightCandidate = {
  source: string;
  id: string;
  input:
    | {
        kind: "remote";
        url: string;
        provider?: RemoteMediaProvider | null;
      }
    | {
        kind: "buffer";
        bytes: Buffer;
        contentType?: string | null;
      };
};

export type AppointmentMediaPreflightFailure = {
  source: string;
  id: string;
  category:
    | "unavailable"
    | "rejected"
    | "oversized"
    | "unsafe_dimensions"
    | "unsupported"
    | "corrupt";
  error: string;
};

export type AppointmentMediaPreflightReport = {
  checked: number;
  passed: number;
  failed: AppointmentMediaPreflightFailure[];
};

type PreflightDependencies = {
  fetchRemote: typeof fetchRemoteImage;
  normalize: (
    bytes: Buffer,
    declaredContentType?: string | null,
  ) => Promise<NormalizedAppointmentImage>;
};

function errorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

export function classifyAppointmentMediaPreflightError(
  error: unknown,
): AppointmentMediaPreflightFailure["category"] {
  const message = errorMessage(error).toLowerCase();
  if (/(?:too_large|size_invalid|response_too_large)/u.test(message)) {
    return "oversized";
  }
  if (/(?:dimensions_unsafe|pixel_limit|decompression)/u.test(message)) {
    return "unsafe_dimensions";
  }
  if (/(?:unsupported|avif|svg|gif|video)/u.test(message)) {
    return "unsupported";
  }
  if (
    /remote_media_(?:url_|host_|provider_host_|redirect_invalid)/u.test(message)
  ) {
    return "rejected";
  }
  if (message.startsWith("remote_media_")) {
    return "unavailable";
  }
  return "corrupt";
}

export async function preflightAppointmentMediaCandidates(
  candidates: readonly AppointmentMediaPreflightCandidate[],
  options?: {
    concurrency?: number;
    dependencies?: Partial<PreflightDependencies>;
  },
): Promise<AppointmentMediaPreflightReport> {
  const dependencies: PreflightDependencies = {
    fetchRemote: options?.dependencies?.fetchRemote ?? fetchRemoteImage,
    normalize: options?.dependencies?.normalize ?? normalizeAppointmentImage,
  };
  const concurrency = Math.min(
    Math.max(Math.floor(options?.concurrency ?? 2), 1),
    8,
  );
  const failures: Array<AppointmentMediaPreflightFailure | null> = Array.from(
    { length: candidates.length },
    () => null,
  );
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < candidates.length) {
      const index = nextIndex;
      nextIndex += 1;
      const candidate = candidates[index];
      if (!candidate) continue;
      try {
        const media =
          candidate.input.kind === "remote"
            ? await dependencies.fetchRemote({
                url: candidate.input.url,
                provider: candidate.input.provider,
              })
            : {
                bytes: candidate.input.bytes,
                contentType:
                  candidate.input.contentType ?? "application/octet-stream",
              };
        await dependencies.normalize(media.bytes, media.contentType);
      } catch (error) {
        failures[index] = {
          source: candidate.source,
          id: candidate.id,
          category: classifyAppointmentMediaPreflightError(error),
          error: errorMessage(error),
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, async () =>
      worker(),
    ),
  );
  const failed = failures.filter(
    (failure): failure is AppointmentMediaPreflightFailure => failure !== null,
  );
  return {
    checked: candidates.length,
    passed: candidates.length - failed.length,
    failed,
  };
}
