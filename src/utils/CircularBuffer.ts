/**
 * 环形缓冲区实现
 * 用于存储最近的价格数据，支持高效的滑动窗口操作
 */

export class CircularBuffer<T> {
  private buffer: (T | undefined)[];
  private head: number = 0;
  private tail: number = 0;
  private _size: number = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new Error('Capacity must be positive');
    }
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  /**
   * 添加元素到缓冲区
   * 如果缓冲区已满，会覆盖最旧的元素
   */
  push(item: T): void {
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;

    if (this._size < this.capacity) {
      this._size++;
    } else {
      // 覆盖最旧元素时，head 也需要移动
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /**
   * 获取最旧的元素 (不移除)
   */
  peek(): T | undefined {
    if (this._size === 0) return undefined;
    return this.buffer[this.head];
  }

  /**
   * 获取最新的元素 (不移除)
   */
  peekLast(): T | undefined {
    if (this._size === 0) return undefined;
    const lastIndex = (this.tail - 1 + this.capacity) % this.capacity;
    return this.buffer[lastIndex];
  }

  /**
   * 获取指定索引的元素 (0 为最旧)
   */
  get(index: number): T | undefined {
    if (index < 0 || index >= this._size) return undefined;
    const actualIndex = (this.head + index) % this.capacity;
    return this.buffer[actualIndex];
  }

  /**
   * 获取当前大小
   */
  get size(): number {
    return this._size;
  }

  /**
   * 检查是否为空
   */
  isEmpty(): boolean {
    return this._size === 0;
  }

  /**
   * 检查是否已满
   */
  isFull(): boolean {
    return this._size === this.capacity;
  }

  /**
   * 清空缓冲区
   */
  clear(): void {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.tail = 0;
    this._size = 0;
  }

  /**
   * 转换为数组 (从最旧到最新)
   */
  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this._size; i++) {
      const item = this.get(i);
      if (item !== undefined) {
        result.push(item);
      }
    }
    return result;
  }

  /**
   * 过滤元素
   */
  filter(predicate: (item: T) => boolean): T[] {
    const result: T[] = [];
    for (let i = 0; i < this._size; i++) {
      const item = this.get(i);
      if (item !== undefined && predicate(item)) {
        result.push(item);
      }
    }
    return result;
  }

  /**
   * 查找最后一个满足条件的元素
   */
  findLast(predicate: (item: T) => boolean): T | undefined {
    for (let i = this._size - 1; i >= 0; i--) {
      const item = this.get(i);
      if (item !== undefined && predicate(item)) {
        return item;
      }
    }
    return undefined;
  }

  /**
   * 对所有元素执行操作
   */
  forEach(callback: (item: T, index: number) => void): void {
    for (let i = 0; i < this._size; i++) {
      const item = this.get(i);
      if (item !== undefined) {
        callback(item, i);
      }
    }
  }

  /**
   * 获取满足时间范围的元素
   * 假设元素有 timestamp 属性
   */
  getInTimeRange(
    startTime: number,
    endTime: number = Date.now()
  ): T[] {
    return this.filter((item) => {
      const timestampedItem = item as unknown as { timestamp: number };
      return (
        timestampedItem.timestamp >= startTime &&
        timestampedItem.timestamp <= endTime
      );
    });
  }

  /**
   * 获取最近 n 毫秒内的元素
   */
  getRecent(milliseconds: number): T[] {
    const startTime = Date.now() - milliseconds;
    return this.getInTimeRange(startTime);
  }

  /**
   * 迭代器支持
   */
  *[Symbol.iterator](): Iterator<T> {
    for (let i = 0; i < this._size; i++) {
      const item = this.get(i);
      if (item !== undefined) {
        yield item;
      }
    }
  }
}

export default CircularBuffer;
