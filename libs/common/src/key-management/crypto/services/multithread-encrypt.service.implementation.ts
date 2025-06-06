// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { defaultIfEmpty, filter, firstValueFrom, fromEvent, map, Subject, takeUntil } from "rxjs";
import { Jsonify } from "type-fest";

import { Decryptable } from "@bitwarden/common/platform/interfaces/decryptable.interface";
import { InitializerMetadata } from "@bitwarden/common/platform/interfaces/initializer-metadata.interface";
import { Utils } from "@bitwarden/common/platform/misc/utils";
import { SymmetricCryptoKey } from "@bitwarden/common/platform/models/domain/symmetric-crypto-key";
import { getClassInitializer } from "@bitwarden/common/platform/services/cryptography/get-class-initializer";

import { ServerConfig } from "../../../platform/abstractions/config/server-config";
import { buildDecryptMessage, buildSetConfigMessage } from "../types/worker-command.type";

import { EncryptServiceImplementation } from "./encrypt.service.implementation";

// TTL (time to live) is not strictly required but avoids tying up memory resources if inactive
const workerTTL = 3 * 60000; // 3 minutes

/**
 * @deprecated Replaced by BulkEncryptionService (PM-4154)
 */
export class MultithreadEncryptServiceImplementation extends EncryptServiceImplementation {
  private worker: Worker;
  private timeout: any;
  private currentServerConfig: ServerConfig | undefined = undefined;

  private clear$ = new Subject<void>();

  /**
   * Sends items to a web worker to decrypt them.
   * This utilises multithreading to decrypt items faster without interrupting other operations (e.g. updating UI).
   */
  async decryptItems<T extends InitializerMetadata>(
    items: Decryptable<T>[],
    key: SymmetricCryptoKey,
  ): Promise<T[]> {
    if (items == null || items.length < 1) {
      return [];
    }

    if (this.useSDKForDecryption) {
      return await super.decryptItems(items, key);
    }

    this.logService.info("Starting decryption using multithreading");

    if (this.worker == null) {
      this.worker = new Worker(
        new URL(
          /* webpackChunkName: 'encrypt-worker' */
          "@bitwarden/common/key-management/crypto/services/encrypt.worker.ts",
          import.meta.url,
        ),
      );
      if (this.currentServerConfig !== undefined) {
        this.updateWorkerServerConfig(this.currentServerConfig);
      }
    }

    this.restartTimeout();

    const id = Utils.newGuid();
    const request = buildDecryptMessage({
      id,
      items: items,
      key: key,
    });

    this.worker.postMessage(request);

    return await firstValueFrom(
      fromEvent(this.worker, "message").pipe(
        filter((response: MessageEvent) => response.data?.id === id),
        map((response) => JSON.parse(response.data.items)),
        map((items) =>
          items.map((jsonItem: Jsonify<T>) => {
            const initializer = getClassInitializer<T>(jsonItem.initializerKey);
            return initializer(jsonItem);
          }),
        ),
        takeUntil(this.clear$),
        defaultIfEmpty([]),
      ),
    );
  }

  override onServerConfigChange(newConfig: ServerConfig): void {
    this.currentServerConfig = newConfig;
    super.onServerConfigChange(newConfig);
    this.updateWorkerServerConfig(newConfig);
  }

  private updateWorkerServerConfig(newConfig: ServerConfig) {
    if (this.worker != null) {
      const request = buildSetConfigMessage({ newConfig });
      this.worker.postMessage(request);
    }
  }

  private clear() {
    this.clear$.next();
    this.worker?.terminate();
    this.worker = null;
    this.clearTimeout();
  }

  private restartTimeout() {
    this.clearTimeout();
    this.timeout = setTimeout(() => this.clear(), workerTTL);
  }

  private clearTimeout() {
    if (this.timeout != null) {
      clearTimeout(this.timeout);
    }
  }
}
