declare module "heic-decode" {
  export type DecodedHeicImage = {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  };

  export type DeferredHeicImage = {
    width: number;
    height: number;
    decode(): Promise<DecodedHeicImage>;
  };

  export type DeferredHeicImages = DeferredHeicImage[] & {
    dispose(): void;
  };

  type DecodeHeic = {
    (input: { buffer: Buffer | Uint8Array | ArrayBuffer }): Promise<DecodedHeicImage>;
    all(input: {
      buffer: Buffer | Uint8Array | ArrayBuffer;
    }): Promise<DeferredHeicImages>;
  };

  const decodeHeic: DecodeHeic;
  export default decodeHeic;
}
