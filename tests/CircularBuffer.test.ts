/**
 * CircularBuffer 单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CircularBuffer } from '../src/utils/CircularBuffer.js';

describe('CircularBuffer', () => {
  let buffer: CircularBuffer<number>;

  beforeEach(() => {
    buffer = new CircularBuffer<number>(5);
  });

  describe('基础操作', () => {
    it('应该正确初始化空缓冲区', () => {
      expect(buffer.size).toBe(0);
      expect(buffer.isEmpty()).toBe(true);
      expect(buffer.isFull()).toBe(false);
    });

    it('应该正确添加元素', () => {
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);

      expect(buffer.size).toBe(3);
      expect(buffer.isEmpty()).toBe(false);
    });

    it('应该在达到容量时覆盖旧元素', () => {
      for (let i = 1; i <= 7; i++) {
        buffer.push(i);
      }

      expect(buffer.size).toBe(5);
      expect(buffer.isFull()).toBe(true);
      expect(buffer.toArray()).toEqual([3, 4, 5, 6, 7]);
    });

    it('应该正确获取最新和最旧元素', () => {
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);

      expect(buffer.peek()).toBe(1);     // 最旧
      expect(buffer.peekLast()).toBe(3); // 最新
    });

    it('空缓冲区返回 undefined', () => {
      expect(buffer.peek()).toBeUndefined();
      expect(buffer.peekLast()).toBeUndefined();
    });
  });

  describe('清空操作', () => {
    it('应该正确清空缓冲区', () => {
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);

      buffer.clear();

      expect(buffer.size).toBe(0);
      expect(buffer.isEmpty()).toBe(true);
    });
  });

  describe('遍历和过滤', () => {
    it('应该正确过滤元素', () => {
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);
      buffer.push(4);
      buffer.push(5);

      const evens = buffer.filter(x => x % 2 === 0);
      expect(evens).toEqual([2, 4]);
    });

    it('应该正确转换为数组', () => {
      buffer.push(10);
      buffer.push(20);
      buffer.push(30);

      expect(buffer.toArray()).toEqual([10, 20, 30]);
    });

    it('应该正确通过索引获取元素', () => {
      buffer.push(10);
      buffer.push(20);
      buffer.push(30);

      expect(buffer.get(0)).toBe(10);
      expect(buffer.get(1)).toBe(20);
      expect(buffer.get(2)).toBe(30);
      expect(buffer.get(3)).toBeUndefined();
    });
  });

  describe('时间窗口过滤', () => {
    interface TimestampItem {
      timestamp: number;
      value: number;
    }

    it('应该正确获取时间窗口内的元素', () => {
      const tsBuffer = new CircularBuffer<TimestampItem>(10);
      const now = Date.now();

      tsBuffer.push({ timestamp: now - 5000, value: 1 }); // 5秒前
      tsBuffer.push({ timestamp: now - 3000, value: 2 }); // 3秒前
      tsBuffer.push({ timestamp: now - 1000, value: 3 }); // 1秒前
      tsBuffer.push({ timestamp: now, value: 4 });        // 现在

      const recent = tsBuffer.getRecent<TimestampItem>(2000); // 最近2秒
      expect(recent.length).toBe(2);
      expect(recent.map(x => x.value)).toEqual([3, 4]);
    });
  });

  describe('迭代器', () => {
    it('应该支持 for...of 迭代', () => {
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);

      const result: number[] = [];
      for (const item of buffer) {
        result.push(item);
      }

      expect(result).toEqual([1, 2, 3]);
    });
  });
});
