import type { Component } from 'vue'
export function createRenderer(registry: Record<string, Component>): (name: string, props: Record<string, unknown>) => Promise<string>
