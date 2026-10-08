import { traceImage, type TraceMode, type TraceOptions, type TraceResult } from './vectorize';

type WorkerRequest = { image: ImageBitmap; mode: TraceMode; options: Omit<TraceOptions, 'onProgress'> };
type WorkerResponse =
  | { type: 'progress'; progress: number }
  | { type: 'result'; result: TraceResult }
  | { type: 'error'; message: string };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

workerScope.onmessage = event => {
  const { image, mode, options } = event.data;
  try {
    let last = 0;
    const result = traceImage(image, mode, {
      ...options,
      onProgress: progress => {
        if (progress - last < 0.02 && progress < 1) return;
        last = progress;
        workerScope.postMessage({ type: 'progress', progress });
      },
    });
    workerScope.postMessage({ type: 'result', result });
  } catch (error) {
    workerScope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Tracing failed.' });
  } finally {
    image.close();
  }
};
