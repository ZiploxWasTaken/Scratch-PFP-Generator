"use client";

import { useState, useRef, useCallback } from "react";
import { parseGIF, decompressFrames } from "gifuct-js";

const MAX_DIMENSION = 500;
const MAX_FILE_SIZE = 512 * 1024; // 512 KB

interface ProcessingStatus {
  stage: string;
  iteration: number;
  currentSize: number;
  currentDimensions: { width: number; height: number };
}

export default function ScratchPFPifier() {
  const [originalFile, setOriginalFile] = useState<File | null>(null);
  const [originalPreview, setOriginalPreview] = useState<string | null>(null);
  const [processedPreview, setProcessedPreview] = useState<string | null>(null);
  const [processedBlob, setProcessedBlob] = useState<Blob | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState<ProcessingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      if (!file.type.startsWith("image/")) {
        setError("Please select an image file");
        return;
      }

      setOriginalFile(file);
      setOriginalPreview(URL.createObjectURL(file));
      setProcessedPreview(null);
      setProcessedBlob(null);
      setError(null);
      setStatus(null);
    },
    []
  );

  const compressStaticImage = async (
    file: File
  ): Promise<{ blob: Blob; url: string }> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = async () => {
        let width = img.width;
        let height = img.height;
        let quality = 0.92;
        let iteration = 0;
        let blob: Blob | null = null;

        // First, resize if needed
        if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
          const scale = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
          width = Math.floor(width * scale);
          height = Math.floor(height * scale);
        }

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d")!;

        // Keep compressing until we meet both conditions
        while (true) {
          iteration++;
          canvas.width = width;
          canvas.height = height;
          ctx.drawImage(img, 0, 0, width, height);

          setStatus({
            stage: "Compressing",
            iteration,
            currentSize: blob ? blob.size : file.size,
            currentDimensions: { width, height },
          });

          // Try to create blob with current settings
          blob = await new Promise<Blob | null>((res) => {
            canvas.toBlob((b) => res(b), "image/png", quality);
          });

          if (!blob) {
            reject(new Error("Failed to create image blob"));
            return;
          }

          // Check if we meet the conditions
          if (
            blob.size <= MAX_FILE_SIZE &&
            width <= MAX_DIMENSION &&
            height <= MAX_DIMENSION
          ) {
            const url = URL.createObjectURL(blob);
            resolve({ blob, url });
            return;
          }

          // If still too big, reduce quality or dimensions
          if (blob.size > MAX_FILE_SIZE) {
            if (quality > 0.1) {
              quality -= 0.05;
            } else {
              // Reduce dimensions
              width = Math.floor(width * 0.9);
              height = Math.floor(height * 0.9);
              quality = 0.92;
            }
          }

          // Safety check
          if (width < 10 || height < 10) {
            reject(new Error("Image cannot be compressed further"));
            return;
          }
        }
      };
      img.onerror = () => reject(new Error("Failed to load image"));
      img.src = URL.createObjectURL(file);
    });
  };

  const compressGIF = async (
    file: File
  ): Promise<{ blob: Blob; url: string }> => {
    const arrayBuffer = await file.arrayBuffer();
    const gif = parseGIF(arrayBuffer);
    const frames = decompressFrames(gif, true);

    if (frames.length === 0) {
      throw new Error("No frames found in GIF");
    }

    let width = gif.lsd.width;
    let height = gif.lsd.height;
    let scale = 1;
    let iteration = 0;

    // Initial resize if needed
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      scale = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
      width = Math.floor(width * scale);
      height = Math.floor(height * scale);
    }

    // Create a temporary canvas to render frames
    const tempCanvas = document.createElement("canvas");
    const tempCtx = tempCanvas.getContext("2d")!;

    // Try different compression levels
    while (true) {
      iteration++;

      setStatus({
        stage: `Processing GIF (${frames.length} frames)`,
        iteration,
        currentSize: file.size,
        currentDimensions: { width, height },
      });

      // Render all frames to check dimensions
      const renderedFrames: { imageData: ImageData; delay: number }[] = [];

      tempCanvas.width = gif.lsd.width;
      tempCanvas.height = gif.lsd.height;

      // Create a patch canvas for the current frame
      const patchCanvas = document.createElement("canvas");
      const patchCtx = patchCanvas.getContext("2d")!;

      for (const frame of frames) {
        // Draw the frame patch
        patchCanvas.width = frame.dims.width;
        patchCanvas.height = frame.dims.height;
        const patchData = patchCtx.createImageData(
          frame.dims.width,
          frame.dims.height
        );
        patchData.data.set(frame.patch);
        patchCtx.putImageData(patchData, 0, 0);

        // Draw patch onto temp canvas at correct position
        tempCtx.drawImage(patchCanvas, frame.dims.left, frame.dims.top);

        // Get the full frame
        const fullFrameData = tempCtx.getImageData(
          0,
          0,
          gif.lsd.width,
          gif.lsd.height
        );
        renderedFrames.push({
          imageData: fullFrameData,
          delay: frame.delay || 100,
        });

        // Handle disposal
        if (frame.disposalType === 2) {
          tempCtx.clearRect(0, 0, gif.lsd.width, gif.lsd.height);
        }
      }

      // Now create the output GIF manually using canvas frames
      // We'll create an animated PNG or compressed GIF
      // For simplicity, we'll create a compressed version by scaling

      const outputCanvas = document.createElement("canvas");
      outputCanvas.width = width;
      outputCanvas.height = height;
      const outputCtx = outputCanvas.getContext("2d")!;

      // Encode as animated GIF using a simple approach
      // We'll use the GIF format directly
      const gifData = await createAnimatedGIF(
        renderedFrames,
        gif.lsd.width,
        gif.lsd.height,
        width,
        height
      );

      const blob = new Blob([gifData], { type: "image/gif" });

      setStatus({
        stage: `Processing GIF (${frames.length} frames)`,
        iteration,
        currentSize: blob.size,
        currentDimensions: { width, height },
      });

      if (
        blob.size <= MAX_FILE_SIZE &&
        width <= MAX_DIMENSION &&
        height <= MAX_DIMENSION
      ) {
        const url = URL.createObjectURL(blob);
        return { blob, url };
      }

      // Reduce dimensions
      width = Math.floor(width * 0.85);
      height = Math.floor(height * 0.85);

      if (width < 10 || height < 10) {
        throw new Error("GIF cannot be compressed further");
      }
    }
  };

  // Simple GIF encoder
  async function createAnimatedGIF(
    frames: { imageData: ImageData; delay: number }[],
    originalWidth: number,
    originalHeight: number,
    targetWidth: number,
    targetHeight: number
  ): Promise<Uint8Array> {
    // Scale frames
    const scaledFrames: { data: Uint8ClampedArray; delay: number }[] = [];

    const scaleCanvas = document.createElement("canvas");
    scaleCanvas.width = targetWidth;
    scaleCanvas.height = targetHeight;
    const scaleCtx = scaleCanvas.getContext("2d")!;

    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = originalWidth;
    srcCanvas.height = originalHeight;
    const srcCtx = srcCanvas.getContext("2d")!;

    for (const frame of frames) {
      srcCtx.putImageData(frame.imageData, 0, 0);
      scaleCtx.clearRect(0, 0, targetWidth, targetHeight);
      scaleCtx.drawImage(srcCanvas, 0, 0, targetWidth, targetHeight);
      const scaledData = scaleCtx.getImageData(0, 0, targetWidth, targetHeight);
      scaledFrames.push({ data: scaledData.data, delay: frame.delay });
    }

    // Build GIF binary
    return encodeGIF(scaledFrames, targetWidth, targetHeight);
  }

  function encodeGIF(
    frames: { data: Uint8ClampedArray; delay: number }[],
    width: number,
    height: number
  ): Uint8Array {
    const output: number[] = [];

    // GIF Header
    output.push(
      ...[0x47, 0x49, 0x46, 0x38, 0x39, 0x61] // GIF89a
    );

    // Logical Screen Descriptor
    output.push(width & 0xff, (width >> 8) & 0xff);
    output.push(height & 0xff, (height >> 8) & 0xff);
    output.push(0xf7); // Global color table, 256 colors
    output.push(0); // Background color index
    output.push(0); // Pixel aspect ratio

    // Global Color Table (256 colors)
    for (let i = 0; i < 256; i++) {
      // Create a simple palette
      const r = (i >> 5) * 36;
      const g = ((i >> 2) & 0x07) * 36;
      const b = (i & 0x03) * 85;
      output.push(r, g, b);
    }

    // Netscape Extension for looping
    output.push(
      0x21,
      0xff,
      0x0b,
      0x4e,
      0x45,
      0x54,
      0x53,
      0x43,
      0x41,
      0x50,
      0x45,
      0x32,
      0x2e,
      0x30, // NETSCAPE2.0
      0x03,
      0x01,
      0x00,
      0x00, // Loop forever
      0x00
    );

    for (const frame of frames) {
      // Graphics Control Extension
      const delayCs = Math.max(2, Math.floor(frame.delay / 10)); // Delay in centiseconds
      output.push(0x21, 0xf9, 0x04);
      output.push(0x04); // Disposal method: restore to background
      output.push(delayCs & 0xff, (delayCs >> 8) & 0xff);
      output.push(0x00); // Transparent color index (none)
      output.push(0x00);

      // Image Descriptor
      output.push(0x2c);
      output.push(0x00, 0x00); // Left
      output.push(0x00, 0x00); // Top
      output.push(width & 0xff, (width >> 8) & 0xff);
      output.push(height & 0xff, (height >> 8) & 0xff);
      output.push(0x00); // No local color table

      // Image Data with LZW
      const minCodeSize = 8;
      output.push(minCodeSize);

      // Convert RGBA to indexed color
      const indexed: number[] = [];
      for (let i = 0; i < frame.data.length; i += 4) {
        const r = frame.data[i];
        const g = frame.data[i + 1];
        const b = frame.data[i + 2];
        // Map to 256 color palette
        const ri = Math.floor(r / 36);
        const gi = Math.floor(g / 36);
        const bi = Math.floor(b / 85);
        const idx = (ri << 5) | (gi << 2) | bi;
        indexed.push(Math.min(255, idx));
      }

      // Simple LZW compression
      const lzwData = lzwEncode(indexed, minCodeSize);

      // Write sub-blocks
      for (let i = 0; i < lzwData.length; i += 255) {
        const chunk = lzwData.slice(i, i + 255);
        output.push(chunk.length);
        output.push(...chunk);
      }
      output.push(0x00); // Block terminator
    }

    // Trailer
    output.push(0x3b);

    return new Uint8Array(output);
  }

  function lzwEncode(data: number[], minCodeSize: number): number[] {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;

    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;
    const maxCode = 4096;

    const dictionary = new Map<string, number>();
    for (let i = 0; i < clearCode; i++) {
      dictionary.set(String(i), i);
    }

    const output: number[] = [];
    let bits = 0;
    let bitCount = 0;

    const writeBits = (code: number, size: number) => {
      bits |= code << bitCount;
      bitCount += size;
      while (bitCount >= 8) {
        output.push(bits & 0xff);
        bits >>= 8;
        bitCount -= 8;
      }
    };

    writeBits(clearCode, codeSize);

    let current = String(data[0]);

    for (let i = 1; i < data.length; i++) {
      const next = current + "," + data[i];
      if (dictionary.has(next)) {
        current = next;
      } else {
        writeBits(dictionary.get(current)!, codeSize);

        if (nextCode < maxCode) {
          dictionary.set(next, nextCode++);
          if (nextCode > (1 << codeSize) && codeSize < 12) {
            codeSize++;
          }
        } else {
          // Reset dictionary
          writeBits(clearCode, codeSize);
          dictionary.clear();
          for (let j = 0; j < clearCode; j++) {
            dictionary.set(String(j), j);
          }
          nextCode = eoiCode + 1;
          codeSize = minCodeSize + 1;
        }

        current = String(data[i]);
      }
    }

    writeBits(dictionary.get(current)!, codeSize);
    writeBits(eoiCode, codeSize);

    if (bitCount > 0) {
      output.push(bits & 0xff);
    }

    return output;
  }

  const processImage = async () => {
    if (!originalFile) return;

    setIsProcessing(true);
    setError(null);
    setProcessedPreview(null);
    setProcessedBlob(null);

    try {
      let result: { blob: Blob; url: string };

      if (originalFile.type === "image/gif") {
        result = await compressGIF(originalFile);
      } else {
        result = await compressStaticImage(originalFile);
      }

      setProcessedPreview(result.url);
      setProcessedBlob(result.blob);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Processing failed");
    } finally {
      setIsProcessing(false);
    }
  };

  const downloadImage = () => {
    if (!processedBlob || !originalFile) return;

    const extension = originalFile.type === "image/gif" ? "gif" : "png";
    const name = originalFile.name.replace(/\.[^/.]+$/, "");
    const url = URL.createObjectURL(processedBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}_scratch_pfp.${extension}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  };

  return (
    <main className="min-h-screen bg-pink-400 p-8 font-mono">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-4xl font-bold text-white mb-2 text-center">
          Scratch PFP-ifier
        </h1>
        <p className="text-pink-100 text-center mb-8">
          Resize and compress images to fit Scratch profile picture requirements
          (500x500px, 512KB max)
        </p>

        <div className="bg-pink-300 p-6 mb-6">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileSelect}
            accept="image/*"
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full bg-pink-500 hover:bg-pink-600 text-white font-bold py-4 px-6 border-0"
          >
            Select Image (PNG, JPG, GIF)
          </button>
        </div>

        {error && (
          <div className="bg-red-500 text-white p-4 mb-6 font-mono">
            {error}
          </div>
        )}

        {originalFile && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            <div className="bg-pink-300 p-4">
              <h2 className="text-xl font-bold text-pink-800 mb-4">Original</h2>
              {originalPreview && (
                <div className="bg-pink-200 p-4 mb-4 flex items-center justify-center min-h-[200px]">
                  <img
                    src={originalPreview}
                    alt="Original"
                    className="max-w-full max-h-[300px]"
                  />
                </div>
              )}
              <div className="text-pink-800 text-sm space-y-1">
                <p>Name: {originalFile.name}</p>
                <p>Size: {formatSize(originalFile.size)}</p>
                <p>Type: {originalFile.type}</p>
              </div>
            </div>

            <div className="bg-pink-300 p-4">
              <h2 className="text-xl font-bold text-pink-800 mb-4">
                Processed
              </h2>
              {processedPreview ? (
                <>
                  <div className="bg-pink-200 p-4 mb-4 flex items-center justify-center min-h-[200px]">
                    <img
                      src={processedPreview}
                      alt="Processed"
                      className="max-w-full max-h-[300px]"
                    />
                  </div>
                  {processedBlob && (
                    <div className="text-pink-800 text-sm space-y-1">
                      <p>Size: {formatSize(processedBlob.size)}</p>
                      {status && (
                        <>
                          <p>
                            Dimensions: {status.currentDimensions.width}x
                            {status.currentDimensions.height}
                          </p>
                          <p>Iterations: {status.iteration}</p>
                        </>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="bg-pink-200 p-4 mb-4 flex items-center justify-center min-h-[200px] text-pink-600">
                  {isProcessing ? (
                    <div className="text-center">
                      <p className="font-bold">Processing...</p>
                      {status && (
                        <div className="mt-2 text-sm">
                          <p>{status.stage}</p>
                          <p>Iteration: {status.iteration}</p>
                          <p>Current size: {formatSize(status.currentSize)}</p>
                        </div>
                      )}
                    </div>
                  ) : (
                    "Click Process to start"
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {originalFile && (
          <div className="flex gap-4">
            <button
              onClick={processImage}
              disabled={isProcessing}
              className="flex-1 bg-pink-600 hover:bg-pink-700 disabled:bg-pink-400 disabled:cursor-not-allowed text-white font-bold py-4 px-6 border-0"
            >
              {isProcessing ? "Processing..." : "Process Image"}
            </button>
            {processedBlob && (
              <button
                onClick={downloadImage}
                className="flex-1 bg-pink-800 hover:bg-pink-900 text-white font-bold py-4 px-6 border-0"
              >
                Download
              </button>
            )}
          </div>
        )}

        <div className="mt-8 bg-pink-300 p-4">
          <h2 className="text-xl font-bold text-pink-800 mb-2">
            How it works
          </h2>
          <ul className="text-pink-800 text-sm space-y-1 list-disc list-inside">
            <li>Resizes images to 500x500 pixels or smaller</li>
            <li>Compresses to 512 KB or less</li>
            <li>Keeps compressing until both conditions are met</li>
            <li>Supports PNG, JPG, and animated GIF files</li>
            <li>GIFs are processed frame-by-frame to preserve animation</li>
          </ul>
        </div>
      </div>
    </main>
  );
}
