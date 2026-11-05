/// <reference path="./islands.d.ts" />
import type { Component } from 'vue'
export interface SsrEvent { type: 'hydration-mismatch' | 'mount-error'; component: string; key: string; page: string; message: string; detail: { phase: string } }
export interface Diagnostics { hydrated: { component: string; key: string }[]; csr: { component: string; key: string }[]; mismatches: string[] }
declare global { interface Window { __ssr: Diagnostics; dataLayer?: unknown[] } }
export function createIslandRegistry(names: Iterable<string>, components: Readonly<Record<string, Component | undefined>>, options?: { warn?: (message: string) => void }): Record<string, Component>
export function mountIslands(options: { registry: Record<string, Component>; scope?: ParentNode; consent?: () => boolean; reporter?: (event: SsrEvent) => void; page?: string; observe?: boolean }): { load(scope?: ParentNode): void; unload(scope: ParentNode): void; destroy(): void }
export function consoleReporter(event: SsrEvent): void
export function callbackReporter(callback: (event: SsrEvent) => void): (event: SsrEvent) => void
export function dataLayerReporter(eventName?: string): (event: SsrEvent) => void
