// -----------------------------------------------------------------------------
// Every text the container produces, in the four languages of the Gladys
// interface. German says "du", Spanish "usted" (test/i18n.test.js).
// ioBroker and its state ids are never translated.
// -----------------------------------------------------------------------------

/** Suffixes of the secondary features of a state ("Ceiling lamp – Brightness"). */
export const ROLE_NAMES = {
  en: {
    state: 'State',
    value: 'Value',
    power: 'On/off',
    brightness: 'Brightness',
    color: 'Colour',
    command: 'Open/close',
    position: 'Position',
    setpoint: 'Setpoint',
  },
  fr: {
    state: 'État',
    value: 'Valeur',
    power: 'Marche/arrêt',
    brightness: 'Luminosité',
    color: 'Couleur',
    command: 'Ouvrir/fermer',
    position: 'Position',
    setpoint: 'Consigne',
  },
  de: {
    state: 'Zustand',
    value: 'Wert',
    power: 'Ein/Aus',
    brightness: 'Helligkeit',
    color: 'Farbe',
    command: 'Öffnen/Schließen',
    position: 'Position',
    setpoint: 'Sollwert',
  },
  es: {
    state: 'Estado',
    value: 'Valor',
    power: 'Encendido/apagado',
    brightness: 'Brillo',
    color: 'Color',
    command: 'Abrir/cerrar',
    position: 'Posición',
    setpoint: 'Consigna',
  },
};

/** Connection statuses (Configuration screen, widget). */
export const STATUS = {
  not_configured: {
    en: 'Type the address of the ioBroker rest-api adapter.',
    fr: "Saisissez l'adresse de l'adaptateur rest-api d'ioBroker.",
    de: 'Gib die Adresse des rest-api-Adapters von ioBroker ein.',
    es: 'Escriba la dirección del adaptador rest-api de ioBroker.',
  },
  invalid_url: {
    en: 'The address of ioBroker is not valid (example: http://192.168.1.40:8093).',
    fr: "L'adresse d'ioBroker n'est pas valide (exemple : http://192.168.1.40:8093).",
    de: 'Die Adresse von ioBroker ist ungültig (Beispiel: http://192.168.1.40:8093).',
    es: 'La dirección de ioBroker no es válida (ejemplo: http://192.168.1.40:8093).',
  },
  auth_failed: {
    en: 'ioBroker refused the access: check the user name and password.',
    fr: "ioBroker refuse l'accès : vérifiez le nom d'utilisateur et le mot de passe.",
    de: 'ioBroker verweigert den Zugriff: Prüfe Benutzername und Passwort.',
    es: 'ioBroker rechaza el acceso: compruebe el usuario y la contraseña.',
  },
  unreachable: {
    en: 'ioBroker (rest-api adapter) is unreachable, new attempt in a moment.',
    fr: 'ioBroker (adaptateur rest-api) est injoignable, nouvel essai dans un instant.',
    de: 'ioBroker (rest-api-Adapter) ist nicht erreichbar, neuer Versuch gleich.',
    es: 'ioBroker (adaptador rest-api) no está accesible, nuevo intento en un momento.',
  },
};

/** Errors returned to Gladys (command toasts, scene action logs). */
export const ERRORS = {
  offline: {
    en: 'ioBroker is not connected.',
    fr: "ioBroker n'est pas connecté.",
    de: 'ioBroker ist nicht verbunden.',
    es: 'ioBroker no está conectado.',
  },
  unknown_feature: {
    en: 'This feature is no longer offered by ioBroker: scan again.',
    fr: "Cette fonctionnalité n'est plus proposée par ioBroker : relancez une recherche.",
    de: 'Diese Funktion bietet ioBroker nicht mehr an: Suche erneut.',
    es: 'ioBroker ya no ofrece esta función: vuelva a buscar.',
  },
  security_disabled: {
    en: 'Commands of locks, gates, garage doors and alarms are disabled in the configuration.',
    fr: 'Les commandes des serrures, portails, portes de garage et alarmes sont désactivées dans la configuration.',
    de: 'Befehle für Schlösser, Tore, Garagentore und Alarmanlagen sind in der Konfiguration deaktiviert.',
    es: 'Los comandos de cerraduras, portones, puertas de garaje y alarmas están desactivados en la configuración.',
  },
  read_only: {
    en: 'ioBroker marks this state read-only (write: false).',
    fr: 'ioBroker indique que cet état est en lecture seule (write: false).',
    de: 'ioBroker markiert diesen State als schreibgeschützt (write: false).',
    es: 'ioBroker indica que este estado es de solo lectura (write: false).',
  },
  out_of_range: {
    en: 'Value outside the limits ioBroker gives for this state.',
    fr: "Valeur hors des limites qu'ioBroker donne pour cet état.",
    de: 'Wert außerhalb der Grenzen, die ioBroker für diesen State angibt.',
    es: 'Valor fuera de los límites que ioBroker indica para este estado.',
  },
  unsupported_value: {
    en: 'This value does not fit this ioBroker state.',
    fr: 'Cette valeur ne convient pas à cet état ioBroker.',
    de: 'Dieser Wert passt nicht zu diesem ioBroker-State.',
    es: 'Este valor no corresponde a este estado de ioBroker.',
  },
  bad_state: {
    en: 'Write the id of the ioBroker state, for example 0_userdata.0.lamp.',
    fr: "Écrivez l'identifiant de l'état ioBroker, par exemple 0_userdata.0.lamp.",
    de: 'Schreibe die ID des ioBroker-States, zum Beispiel 0_userdata.0.lamp.',
    es: 'Escriba el identificador del estado de ioBroker, por ejemplo 0_userdata.0.lamp.',
  },
  not_found: {
    en: 'ioBroker does not know this state: ',
    fr: 'ioBroker ne connaît pas cet état : ',
    de: 'ioBroker kennt diesen State nicht: ',
    es: 'ioBroker no conoce este estado: ',
  },
  forbidden: {
    en: 'ioBroker refused: the user has no right to write this state.',
    fr: "ioBroker refuse : l'utilisateur n'a pas le droit d'écrire cet état.",
    de: 'ioBroker lehnt ab: Der Benutzer darf diesen State nicht schreiben.',
    es: 'ioBroker rechaza: el usuario no tiene derecho a escribir este estado.',
  },
  refused: {
    en: 'ioBroker refused the command: ',
    fr: 'ioBroker a refusé la commande : ',
    de: 'ioBroker hat den Befehl abgelehnt: ',
    es: 'ioBroker rechazó el comando: ',
  },
};

/** Words of the connection test and of the widget. */
export const WORDS = {
  en: {
    connected: 'Connected',
    unreachable: 'Unreachable',
    not_configured: 'Not configured',
    auth_failed: 'Access refused',
    connecting: 'Connecting',
    version: 'Version',
    connection: 'Connection',
    live: 'Live updates',
    live_on: 'Long polling',
    live_off: 'Polling',
    offered: 'Devices offered',
    added: 'Devices added',
    followed: 'States followed',
    reload: 'Reload',
    reloaded: 'Object list read again.',
  },
  fr: {
    connected: 'Connecté',
    unreachable: 'Injoignable',
    not_configured: 'Non configuré',
    auth_failed: 'Accès refusé',
    connecting: 'Connexion',
    version: 'Version',
    connection: 'Connexion',
    live: 'Mises à jour',
    live_on: 'En direct',
    live_off: 'Interrogation',
    offered: 'Appareils proposés',
    added: 'Appareils ajoutés',
    followed: 'États suivis',
    reload: 'Relire',
    reloaded: 'Liste des objets relue.',
  },
  de: {
    connected: 'Verbunden',
    unreachable: 'Nicht erreichbar',
    not_configured: 'Nicht konfiguriert',
    auth_failed: 'Zugriff verweigert',
    connecting: 'Verbinde',
    version: 'Version',
    connection: 'Verbindung',
    live: 'Aktualisierung',
    live_on: 'Live',
    live_off: 'Abfrage',
    offered: 'Angebotene Geräte',
    added: 'Hinzugefügte Geräte',
    followed: 'Verfolgte States',
    reload: 'Neu laden',
    reloaded: 'Objektliste neu gelesen.',
  },
  es: {
    connected: 'Conectado',
    unreachable: 'No accesible',
    not_configured: 'Sin configurar',
    auth_failed: 'Acceso rechazado',
    connecting: 'Conectando',
    version: 'Versión',
    connection: 'Conexión',
    live: 'Actualizaciones',
    live_on: 'En directo',
    live_off: 'Consulta periódica',
    offered: 'Dispositivos ofrecidos',
    added: 'Dispositivos añadidos',
    followed: 'Estados seguidos',
    reload: 'Recargar',
    reloaded: 'Lista de objetos releída.',
  },
};

/**
 * The message of the "Test the connection" action.
 * @param {object} r { version, devices, states, ignored: [[reason, count]] }
 */
export function testMessage({ version, devices, states, ignored }) {
  const list = ignored
    .slice(0, 8)
    .map(([reason, count]) => `${reason} (${count})`)
    .join(', ');
  const none = { en: 'none', fr: 'aucun', de: 'keine', es: 'ninguno' };
  const rest = (lang) => list || none[lang];
  return {
    en: `Connected to ioBroker ${version}: ${devices} devices offered (${states} states). Roles not imported: ${rest('en')}.`,
    fr: `Connecté à ioBroker ${version} : ${devices} appareils proposés (${states} états). Rôles non importés : ${rest('fr')}.`,
    de: `Mit ioBroker ${version} verbunden: ${devices} Geräte angeboten (${states} States). Nicht importierte Rollen: ${rest('de')}.`,
    es: `Conectado a ioBroker ${version}: ${devices} dispositivos ofrecidos (${states} estados). Roles no importados: ${rest('es')}.`,
  };
}

/** An Error whose message is in the configured language, with the four kept for tests. */
export function localizedError(text, language, detail = '') {
  const err = new Error(`${text[language] ?? text.en}${detail}`);
  err.texts = text;
  return err;
}
