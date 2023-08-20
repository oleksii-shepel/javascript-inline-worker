


export class CancellationToken {
  private shared: ArrayBuffer;
  private array: Int32Array;

  constructor() {
    if(!crossOriginIsolated) {
      console.warn("CancellationToken is not supported in this environment. Please add following two headers to the top level document: 'Cross-Origin-Embedder-Policy': 'require-corp'; 'Cross-Origin-Opener-Policy': 'same-origin';");
    }

    this.shared = crossOriginIsolated? new SharedArrayBuffer(4): new ArrayBuffer(4);
    this.array = new Int32Array(this.shared);
  }

  public cancel(): void {
    if (this.array) {
      Atomics.store(this.array, 0, 1);
    }
  }

  public reset(): void {
    if (this.array) {
      Atomics.store(this.array, 0, 0);
    }
  }

  public get cancelled(): boolean {
    return !!this.array && this.array[0] === 1;
  }

  public get buffer(): ArrayBuffer {
    return this.shared;
  }
}



export interface WorkerHelpers {
  cancelled: Function;
  next: Function;
  progress: Function;
  done: Function;
  error: Function;
}



export type WorkerResult = any;



export type WorkerTask = (data: any, helpers: WorkerHelpers | any) => WorkerResult | Promise<WorkerResult>;



export class InlineWorker {
  private cancellationToken: CancellationToken | null;
  private fnBody: string;
  private worker: Worker | null;
  private onprogress: ((data: number) => void);
  private onnext: ((data: any) => void);
  private injected: string[];
  private promise: Promise<any> | null;
  constructor(task: WorkerTask) {

    if (!isWorkerSupported()) {
      throw new Error('Web Worker is not supported');
    }
    this.cancellationToken = crossOriginIsolated? new CancellationToken(): null;

    // function body cleaned from WEBPACK_IMPORTS
    let taskBody = task.toString().replace(/(\(\d+\s*,\s*[^.]+\.)(\w+)(\)\()(.*)(\))/g, "$2($4)");
    this.fnBody = `function cancelled(){return 1===Atomics.load(self.cancellationBuffer,0)}function progress(e){self.postMessage({type:"progress",value:e})}function next(e){self.postMessage({type:"next",value:e})}function promisify(e){return(n,t)=>new Promise((a,o)=>{let r=!1,s=!1,c=e=>{r=!0,a(e)},l=e=>{s=!0,o(e)},i=e(n,{...t,done:c,error:l});if(i instanceof Promise)return i.then(a,o);if(!r&&!s&&void 0!==i)return a(i),i;if(cancelled()){a(void 0);return}})}self.onmessage=function(event){self.cancellationBuffer=new Int32Array(event.data.cancellationBuffer??new ArrayBuffer(4));let promise=promisify((${taskBody}));promise(event.data.data,{cancelled,next,progress}).then(e=>{cancelled()?self.postMessage({type:"cancelled",value:void 0}):self.postMessage({type:"done",value:e})}).catch(e=>self.postMessage({type:"error",error:e}))};`

    this.worker = this.promise = null;
    this.injected  = []; this.onprogress = this.onnext = () => {};
  }

  public static terminate(workers: InlineWorker[]): void {
    workers.forEach(worker => worker.worker?.terminate());
  }

  public cancel(): void {
    if(this.worker) {
      this.cancellationToken?.cancel();
    }
  }

  public terminate(): void {
    if(this.worker) {
      this.worker.terminate();
    }
  }

  public run(data?: any, transferList?: Transferable[]): Promise<any> {
    if(!this.promise) {
      this.cancellationToken?.reset();
      let blob = new Blob([this.fnBody].concat(this.injected), { type: 'application/javascript' });
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

  running() {
    return !!this.promise;
  }

  progress(fn: (data: any) => void): InlineWorker {
    this.onprogress = fn;
    return this;
  }

  subscribe(fn: (data: any) => void): InlineWorker {
    this.onnext = fn;
    return this;
  }

  public inject(...args: Function[]): InlineWorker {
    this.injected = this.injected ?? []
    for (let i = 0; i < args.length; i++) {
      let fn: Function = args[i];
      if (typeof fn === 'function') {
        let fnBody = fn.toString();
        //check if function is anonymous and name it
        fnBody = fnBody.replace(/function[\s]*\(/, `\n\nfunction ${fn.name}(`);

        if(this.injected.indexOf(fnBody) === -1) {
          this.injected.push(fnBody);
        }
      }
    }
    return this;
  }
}



export function isWorkerSupported(): boolean {
  return !!Worker;
}
