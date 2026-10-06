import { traceImage } from './vectorize';

type WorkerRequest = { image: ImageBitmap };
type WorkerResponse =
  | { type: 'progress'; progress: number }
  | { type: 'result'; result: ReturnType<typeof traceImage> }
  | { type: 'error'; message: string };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

workerScope.onmessage = event => {
  const { image } = event.data;
  try {
    const result = traceImage(image, 'max', 22, progress => {
      workerScope.postMessage({ type: 'progress', progress });
    });
    workerScope.postMessage({ type: 'result', result });
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Max tracing failed.',
    });
  } finally {
    image.close();
  }
};
