import { WorkerMethod, isWebpackBundlerPresent, isWorkerSupported } from "./abstractWorker";
import { WebWorker } from "./abstractWorker";
import { CancellationToken } from "./cancellationToken";

export class InlineWorker extends WebWorker {
  private cancellationToken: CancellationToken | null;
  private workerbody: string;
  private onprogress: ((data: number) => void);
  private onnext: ((data: any) => void);
  private injected: string[];
  private promise: Promise<any> | null;
  constructor(func: WorkerMethod) {
    super();

    if (!isWorkerSupported()) {
      throw new Error('Web Worker is not supported');
    }

    this.cancellationToken = crossOriginIsolated? new CancellationToken(): null;
    let funcbody = func.toString()

    if(isWebpackBundlerPresent()) {
      // get rid of indirect function calls generated by WEBPACK
      funcbody = funcbody.replace(/\((?:.*,)(?:.*WEBPACK_IMPORTED_MODULE.*\.)(.*)\)(\(.*\))/g, "$1$2");
    }

    this.workerbody = `

      function __worker_cancelled__() {
        return Atomics.load(__worker_cancellationBuffer__, 0) === 1;
      }

      function __worker_next__(value) {
        self.postMessage({type: 'next', value});
      }

      function __worker_progress__(value) {
        self.postMessage({type: 'progress', value});
      }

      self.onmessage = function (event) {
        __worker_cancellationBuffer__ = new Int32Array(event.data.cancellationBuffer ?? new ArrayBuffer(4));
        const __worker_promise__ = new Promise((__worker_resolve__, __worker_reject__) => {
          let __worker_resolved__ = false, __worker_rejected__ = false;
          const __worker_done__ = (args) => { __worker_resolved__ = true; __worker_resolve__(args); };
          const __worker_error__ = (args) => { __worker_rejected__ = true; __worker_reject__(args); };
          __worker_data__ = event.data.data; __worker_helpers__ = {cancelled: __worker_cancelled__, next: __worker_next__, progress: __worker_progress__, done: __worker_done__, error: __worker_error__};
          const __worker_result__ = (${funcbody})(__worker_data__, __worker_helpers__);
          if (__worker_result__ instanceof Promise) {
            return __worker_result__.then(__worker_resolve__, __worker_reject__);
          } else if(!__worker_resolved__ && !__worker_rejected__ && __worker_result__ !== undefined) {
            __worker_resolve__(__worker_result__); return __worker_result__;
          } else if(__worker_cancelled__()) {
            __worker_resolve__(undefined); return;
          }
        }).then(value => { if(!__worker_cancelled__()) { self.postMessage({type: "done", value: value}); }
                            else { self.postMessage({type: "cancelled", value: undefined}); }})
          .catch(error => self.postMessage({type: "error", error: error}));
      };`;

    this.promise = null;
    this.injected  = []; this.onprogress = this.onnext = () => {};
  }

  terminate(): void {
    if(this.worker) {
      this.worker.terminate();
    }
  }

  cancel(): void {
    if(this.worker) {
      this.cancellationToken?.cancel();
    }
  }

  run(data?: any, transferList?: Transferable[]): Promise<any> {
    if(!this.promise) {
      this.cancellationToken?.reset();
      let blob = new Blob([this.workerbody].concat(this.injected), { type: 'application/javascript' });
      this.worker = new Worker(URL.createObjectURL(blob));
      this.worker.postMessage({ data: data, cancellationBuffer: this.cancellationToken?.buffer}, transferList as any);
      this.promise = new Promise((resolve, reject) => {
        this.worker!.onmessage = (e: MessageEvent) => {
          if (e.data?.type === 'done') { this.promise = null; resolve(e.data.value); }
          else if (e.data?.type === 'progress') { this.onprogress && this.onprogress(e.data.value); }
          else if (e.data?.type === 'next') { this.onnext && this.onnext(e.data.value); }
          else if (e.data?.type === 'cancelled') { this.promise = null; resolve(undefined); }
          else if (e.data?.type === 'error') { this.promise = null; reject(e.data.error); }
        }
      });
    }

    return this.promise;
  }

  running(): boolean {
    return !!this.promise;
  }

  progress(fn: (data: any) => void): WebWorker {
    this.onprogress = fn;
    return this;
  }

  subscribe(fn: (data: any) => void): WebWorker {
    this.onnext = fn;
    return this;
  }

  inject(...args: Function[]): WebWorker {
    this.injected = this.injected ?? []
    for (let i = 0; i < args.length; i++) {
      let fn: Function = args[i];
      if (typeof fn === 'function') {
        let fnBody = fn.toString();
        // check if function is anonymous and name it
        fnBody = fnBody.replace(/function[\s]*\(/, `function ${fn.name}(`);

        if(this.injected.indexOf(fnBody) === -1) {
          this.injected.push(fnBody);
        }
      }
    }
    return this;
  }
}
