export interface Alert {
  /** Alertas com a mesma chave não se repetem dentro da janela do adapter. */
  key: string;
  text: string;
}

/** Avisa a RMoro quando algo precisa de atenção. Nunca deve lançar erro para quem chama. */
export interface AlertNotifier {
  notify(alert: Alert): Promise<void>;
}

export const noopAlerts: AlertNotifier = { notify: async () => {} };
