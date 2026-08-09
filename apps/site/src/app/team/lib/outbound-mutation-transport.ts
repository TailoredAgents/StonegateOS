function isTransportFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error !== null &&
      typeof error === "object" &&
      "name" in error &&
      error.name === "AbortError")
  );
}

export async function retryOutboundMutationOnce<T>(
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (!isTransportFailure(error)) throw error;
    return request();
  }
}
