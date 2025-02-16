import { ConductorLogger } from "../common";
import { ConductorWorker } from "./Worker";
import { Task, TaskResourceService, TaskResult } from "../common/open-api";
import { TaskManagerOptions } from "./TaskManager";

const DEFAULT_ERROR_MESSAGE = "An unknown error occurred";
const MAX_RETRIES = 3;

export type TaskErrorHandler = (error: Error, task?: Task) => void;

export interface RunnerArgs {
  worker: ConductorWorker;
  taskResource: TaskResourceService;
  options: Required<TaskManagerOptions>;
  logger?: ConductorLogger;
  onError?: TaskErrorHandler;
}

//eslint-disable-next-line
export const noopErrorHandler: TaskErrorHandler = (__error: Error) => {};

const noopLogger: ConductorLogger = {
  //eslint-disable-next-line
  debug: (...args: any) => {},
  //eslint-disable-next-line
  info: (...args: any) => {},
  //eslint-disable-next-line
  error: (...args: any) => {},
};

/**
 * Responsible for polling and executing tasks from a queue.
 *
 * Because a `poll` in conductor "pops" a task off of a conductor queue,
 * each runner participates in the poll -> work -> update loop.
 * We could potentially split this work into a separate "poller" and "worker" pools
 * but that could lead to picking up more work than the pool of workers are actually able to handle.
 *
 */
export class TaskRunner {
  isPolling = false;
  taskResource: TaskResourceService;
  worker: ConductorWorker;
  logger: ConductorLogger;
  options: Required<TaskManagerOptions>;
  errorHandler: TaskErrorHandler;

  constructor({
    worker,
    taskResource,
    options,
    logger = noopLogger,
    onError: errorHandler = noopErrorHandler,
  }: RunnerArgs) {
    this.taskResource = taskResource;
    this.logger = logger;
    this.worker = worker;
    this.options = options;
    this.errorHandler = errorHandler;
  }

  /**
   * Starts polling for work
   */
  startPolling = () => {
    if (this.isPolling) {
      throw new Error("Runner is already started");
    }

    this.isPolling = true;
    return this.poll();
  };
  /**
   * Stops Polling for work
   */
  stopPolling = () => {
    this.isPolling = false;
  };

  poll = async () => {
    while (this.isPolling) {
      try {
        const { workerID } = this.options;
        const task = await this.taskResource.poll(
          this.worker.taskDefName,
          workerID,
          this.options.domain
        );
        if (task && task.taskId) {
          await this.executeTask(task);
        } else {
          this.logger.debug(`No tasks for ${this.worker.taskDefName}`);
        }
      } catch (unknownError: unknown) {
        this.handleUnknownError(unknownError);
        this.errorHandler(unknownError as Error);
      }

      await new Promise((r) =>
        setTimeout(() => r(true), this.options.pollInterval)
      );
    }
  };

  updateTaskWithRetry = async (task: Task, taskResult: TaskResult) => {
    let retryCount = 0;
    while (retryCount < MAX_RETRIES) {
      try {
        await this.taskResource.updateTask1(taskResult);
        return;
      } catch (error: unknown) {
        this.errorHandler(error as Error, task);
        this.logger.error(
          `Error updating task ${taskResult.taskId} on retry ${retryCount}`,
          error
        );
        retryCount++;
        await new Promise((r) => setTimeout(() => r(true), retryCount * 10));
      }
    }
    this.logger.error(
      `Unable to update task ${taskResult.taskId} after ${retryCount} retries`
    );
  };

  executeTask = async (task: Task) => {
    try {
      const result = await this.worker.execute(task);
      await this.updateTaskWithRetry(task, {
        ...result,
        workflowInstanceId: task.workflowInstanceId!,
        taskId: task.taskId!,
      });
      this.logger.debug(`Finished polling for task ${task.taskId}`);
    } catch (error: unknown) {
      await this.updateTaskWithRetry(task, {
        workflowInstanceId: task.workflowInstanceId!,
        taskId: task.taskId!,
        reasonForIncompletion:
          (error as Record<string, string>)?.message ?? DEFAULT_ERROR_MESSAGE,
        status: "FAILED",
        outputData: {},
      });
      this.errorHandler(error as Error, task);
      this.logger.error(`Error executing ${task.taskId}`, error);
    }
  };

  handleUnknownError = (unknownError: unknown) => {
    let message = "";
    let stack: string | undefined = "";
    if ((unknownError as Error).stack) {
      stack = (unknownError as Error).stack;
    }
    if ((unknownError as Error).message) {
      message = (unknownError as Error).message;
    }
    this.logger.error(
      `Error for ${this.worker.taskDefName}: error: ${message}, stack: ${stack}`
    );
  };
}
