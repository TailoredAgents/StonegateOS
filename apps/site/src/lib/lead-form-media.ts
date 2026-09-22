async function shrinkImageIfNeeded(file: File): Promise<File> {
  const MAX_BYTES = 1_800_000;
  if (file.size <= MAX_BYTES) return file;
  if (typeof window === "undefined") return file;
  if (!file.type.startsWith("image/")) return file;

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;

  const maxDimension = 1600;
  const scale = Math.min(
    1,
    maxDimension / Math.max(bitmap.width, bitmap.height),
  );
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.72);
  });
  if (!blob) return file;

  const baseName = file.name.replace(/\.[^/.]+$/u, "") || "photo";
  return new File([blob], `${baseName}.jpg`, { type: "image/jpeg" });
}

function getVideoFrameTargetCount(
  videoFileCount: number,
  imageFileCount: number,
): number {
  const MAX_UPLOAD_IMAGES = 8;
  const remainingSlots = Math.max(0, MAX_UPLOAD_IMAGES - imageFileCount);
  if (videoFileCount <= 0 || remainingSlots <= 0) return 0;
  const perVideo = Math.max(1, Math.floor(remainingSlots / videoFileCount));
  return Math.min(4, perVideo);
}

export async function prepareMediaUploads(files: File[]): Promise<File[]> {
  const imageFiles = files.filter((file) => file.type.startsWith("image/"));
  const videoFiles = files.filter((file) => file.type.startsWith("video/"));
  const preparedImages = await Promise.all(
    imageFiles.map((file) => shrinkImageIfNeeded(file)),
  );
  const frameTargetCount = getVideoFrameTargetCount(
    videoFiles.length,
    preparedImages.length,
  );
  if (videoFiles.length === 0 || frameTargetCount <= 0) {
    return preparedImages.slice(0, 8);
  }

  const frameFiles = (
    await Promise.all(
      videoFiles.map((file) => extractVideoFrames(file, frameTargetCount)),
    )
  ).flat();
  return [...preparedImages, ...frameFiles].slice(0, 8);
}

async function extractVideoFrames(
  file: File,
  frameCount: number,
): Promise<File[]> {
  if (typeof window === "undefined" || frameCount <= 0) return [];

  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.src = objectUrl;

  try {
    await waitForVideoEvent(video, "loadedmetadata");
    const duration =
      Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : 0;
    if (duration <= 0) return [];

    const sourceWidth = Math.max(1, video.videoWidth || 1280);
    const sourceHeight = Math.max(1, video.videoHeight || 720);
    const scale = Math.min(1, 1600 / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];

    const timestamps = buildVideoFrameTimestamps(duration, frameCount);
    const frames: File[] = [];
    const baseName = file.name.replace(/\.[^/.]+$/u, "") || "video";

    for (let index = 0; index < timestamps.length; index += 1) {
      const timestamp = timestamps[index]!;
      await seekVideoTo(video, timestamp);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await canvasToBlob(canvas, "image/jpeg", 0.76);
      if (!blob) continue;
      frames.push(
        new File([blob], `${baseName}-frame-${index + 1}.jpg`, {
          type: "image/jpeg",
        }),
      );
    }

    return frames;
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

function buildVideoFrameTimestamps(
  durationSeconds: number,
  frameCount: number,
): number[] {
  if (frameCount <= 1) {
    return [
      Math.max(
        0,
        Math.min(durationSeconds * 0.5, Math.max(0, durationSeconds - 0.05)),
      ),
    ];
  }

  const startRatio = 0.15;
  const endRatio = 0.85;
  const timestamps: number[] = [];
  for (let index = 0; index < frameCount; index += 1) {
    const progress = frameCount === 1 ? 0.5 : index / (frameCount - 1);
    const ratio = startRatio + (endRatio - startRatio) * progress;
    timestamps.push(
      Math.max(
        0,
        Math.min(durationSeconds * ratio, Math.max(0, durationSeconds - 0.05)),
      ),
    );
  }
  return timestamps;
}

function waitForVideoEvent(
  video: HTMLVideoElement,
  eventName: "loadedmetadata" | "seeked",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleSuccess = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Unable to read the uploaded video."));
    };
    const cleanup = () => {
      video.removeEventListener(eventName, handleSuccess);
      video.removeEventListener("error", handleError);
    };
    video.addEventListener(eventName, handleSuccess, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });
}

async function seekVideoTo(
  video: HTMLVideoElement,
  timestampSeconds: number,
): Promise<void> {
  if (Math.abs(video.currentTime - timestampSeconds) < 0.05) return;
  const seekPromise = waitForVideoEvent(video, "seeked");
  video.currentTime = timestampSeconds;
  await seekPromise;
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}
