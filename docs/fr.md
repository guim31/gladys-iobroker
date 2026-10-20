# Pont ioBroker

Cette intégration amène les états de votre [ioBroker](https://www.iobroker.net) dans Gladys : lampes,
prises, volets, thermostats, capteurs et détecteurs deviennent des appareils Gladys, suivis en direct
et pilotables. Pratique pour passer à Gladys en douceur, ou faire tourner les deux côte à côte.

Testée contre un vrai ioBroker (js-controller 7.2, adaptateur rest-api 4.0) en Docker, avec des objets
Homematic IP, Shelly et Zigbee reproduits d'après leurs adaptateurs. Sans lien avec ioBroker.

## Prérequis

- Un ioBroker joignable depuis la machine de Gladys.
- L'adaptateur **REST API** (`rest-api`) installé dans ioBroker, avec une instance (Adaptateurs →
  chercher « REST API » → installer, puis garder le port par défaut **8093**). L'ancien adaptateur
  `simple-api` n'est pas utilisé.
- Facultatif : si vous cochez **Authentification** dans l'instance rest-api, un utilisateur ioBroker
  pour Gladys. Le plus sûr est un utilisateur dédié, avec les droits de lecture, et d'écriture sur ce
  que Gladys doit piloter.

## Configuration

### Adresse et utilisateur

- **Adresse de l'adaptateur rest-api** : l'adresse IP d'ioBroker et le port de l'adaptateur, par
  exemple `http://192.168.1.40:8093` (`192.168.1.40` seul prend le port 8093). Pas de nom en `.local`,
  pas `localhost` : l'intégration tourne dans son propre conteneur.
- **Nom d'utilisateur** et **Mot de passe** : seulement si l'authentification est cochée dans
  l'instance rest-api. Des identifiants faux affichent « Accès refusé » dans l'écran de configuration.

Puis **Tester la connexion** : elle donne la version d'ioBroker, le nombre d'appareils proposés, et les
rôles non importés, avec leur nombre.

### Choisir ce qui est importé

Par défaut, tout état que Gladys sait afficher est proposé dans l'onglet **Découverte**. Sur une grosse
installation, resserrez :

- **Seulement ces objets ioBroker** : motifs d'identifiants, séparés par des virgules, `*` pour
  n'importe quel texte, par exemple `hm-rpc.0.*, shelly.0.*, 0_userdata.0.*`. Seuls ces objets sont lus
  dans ioBroker.
- **Seulement les objets de ces pièces** : pièces d'ioBroker (`enum.rooms`), par nom dans n'importe
  quelle langue ou par identifiant, par exemple `Salon, Cuisine`.
- **États à écarter** : motifs d'identifiants jamais importés, par exemple `*.RSSI_*`.

Les états d'ioBroker lui-même (`system.*`, le canal `info` de chaque adaptateur) ne sont jamais
importés.

### Serrures, portails, portes de garage et alarmes

Ils sont **en lecture seule par défaut** : Gladys affiche leur état, mais ne peut ni les ouvrir, ni les
déverrouiller, ni les désarmer, ni depuis l'appareil, ni depuis une scène, ni par un assistant vocal.
Ils sont reconnus à leur rôle (`switch.lock`, `switch.gate`, `button.open.door`, rôles d'alarme) et,
pour les simples relais, à leur nom ou identifiant (garage, portail, serrure, alarme, gate, lock,
Garagentor…). Ne cochez **Autoriser serrures, portails, portes de garage et alarmes** que si vous
l'acceptez.

### Options

- **Intervalle minimum entre deux valeurs d'un capteur** : un compteur qui publie chaque seconde est
  transmis à Gladys au plus à ce rythme (10 s par défaut). Interrupteurs, lampes et détecteurs ne sont
  jamais retardés.
- **États surveillés pour les scènes** : identifiants d'états (`*` accepté) qui déclenchent le
  déclencheur de scène, même s'ils ne sont pas ajoutés à Gladys.
- **Langue des noms de fonctionnalités** : le français par défaut.

## Ce que vous obtenez

### Appareils

Un appareil Gladys par **appareil** ioBroker (par exemple un actionneur Homematic IP avec tous ses
canaux), sinon par **canal**, sinon par état seul (un état de `0_userdata`). Sa pièce, s'il en a une,
est ajoutée à son nom. Les fonctionnalités viennent du **rôle** de chaque état :

| Rôle ioBroker                                                   | Fonctionnalité Gladys                     |
| --------------------------------------------------------------- | ----------------------------------------- |
| `switch`, `switch.power`, `switch.light`, `state` modifiable    | interrupteur ou marche/arrêt de lampe     |
| `level.dimmer`, `level.brightness`                              | luminosité (et marche/arrêt si seul)      |
| `level.color.rgb`                                               | couleur de lampe                          |
| `level.blind`, `value.blind`                                    | position du volet, ouvrir/fermer/arrêter  |
| `level.temperature`                                             | consigne de thermostat                    |
| `value.temperature`, `value.humidity`, `value.pressure`         | température, humidité, pression           |
| `value.brightness`, `value.co2`, `value.uv`, `value.speed.wind` | luminosité, CO2, UV, vitesse du vent      |
| `value.power`, `value.energy`, `value.power.consumption`        | puissance (W), index d'énergie (Wh, kWh)  |
| `value.voltage`, `value.current`, `value.battery`               | tension, courant, batterie                |
| `sensor.window`, `sensor.door`, `value.window`                  | détecteur d'ouverture                     |
| `sensor.motion`, `sensor.presence`                              | mouvement, présence                       |
| `sensor.alarm.flood`, `sensor.alarm.fire`, `indicator.lowbat`   | fuite, fumée, batterie faible             |
| `switch.lock`                                                   | serrure (lecture seule sauf autorisation) |
| `value`, `level` avec une unité connue (°C, W, kWh, hPa, lx…)   | le capteur de cette unité                 |

Un état n'est pilotable que si son objet indique `write: true`. Les commandes partent comme depuis
l'interface d'ioBroker (`ack: false`) : l'adaptateur de l'appareil les exécute, et la valeur qu'il
confirme s'affiche dans Gladys. Seuls les états des appareils ajoutés à Gladys sont suivis. Les états de `0_userdata` et `javascript`, qu'aucun adaptateur ne confirme, s'affichent dès qu'ils sont écrits. Les motifs d'identifiants respectent la casse, comme les identifiants d'ioBroker.

### Widget du tableau de bord

**ioBroker** affiche la connexion, la façon dont arrivent les valeurs (en direct ou par
interrogation), la version d'ioBroker, les appareils proposés et ajoutés et les états suivis. Son
bouton **Relire** relit les objets.

### Déclencheurs de scène

**État ioBroker modifié** lance une scène quand un état surveillé (configuration) change de valeur.
Filtres : l'identifiant de l'état, et en option la nouvelle valeur. Variables : `id`, `name`, `value`,
`old_value`.

### Actions de scène

**Écrire un état ioBroker** écrit une valeur dans n'importe quel état, ajouté à Gladys ou non : `true`,
`false`, `50`, `19,5`, un texte. La valeur est convertie au type de l'état. Les états en lecture seule
(`write: false`) et, sauf autorisation, les états de sécurité sont refusés.

## Exemples de scènes

- **Bonne nuit** : à 23 h, écrire `true` dans `0_userdata.0.good_night` pour lancer votre script
  ioBroker qui ferme les volets, pendant que Gladys éteint ses propres lampes.
- **Lave-linge terminé** : quand la puissance de la prise Homematic reste sous 5 W, Gladys vous envoie
  un message.
- **Sonnette** : surveiller `0_userdata.0.doorbell` ; quand il passe à `true`, Gladys joue un son et
  affiche la caméra.

## Dépannage

- **Injoignable** : vérifiez l'adresse et le port (8093), que l'instance rest-api tourne (verte dans
  ioBroker), et que la machine de Gladys peut la joindre.
- **Accès refusé** : l'authentification est cochée dans l'instance rest-api : renseignez le nom
  d'utilisateur et le mot de passe, et vérifiez les droits de cet utilisateur.
- **Un appareil manque** : **Tester la connexion** montre les rôles non importés. Donnez à l'état un
  rôle standard dans ioBroker (objet → modifier → rôle), ou utilisez l'action de scène.
- **Les valeurs arrivent en retard** : le widget indique « Interrogation » quand le long polling de
  rest-api ne passe pas (un proxy entre les deux) : les états sont alors lus toutes les 30 secondes.
- Plus de détails dans les journaux de l'intégration, avec `LOG_LEVEL=debug`.

## Limites

- ioBroker ne pousse pas les valeurs : rest-api est suivi par long polling, un changement par requête,
  et les états suivis sont relus toutes les 5 minutes, ce qui rattrape aussi un changement que rest-api
  n'aurait pas pu transmettre.
- Le rôle d'un état décide de tout : un état au rôle générique (`state`, `value` sans unité) ou un texte
  n'est pas importé (déclencheur et action de scène pour lui). Température de couleur, teinte et
  inclinaison ne sont pas importées.
- `switch.lock` : vrai veut dire déverrouillé dans ioBroker (STATE_ROLES), affiché « déverrouillé »
  dans Gladys.
- `level.blind` est pris comme ioBroker le définit (maximum = ouvert) ; un adaptateur qui l'inverse
  affiche une position inversée.
- Les noms des fonctionnalités sont ceux d'ioBroker à l'ajout de l'appareil ; un renommage ultérieur
  dans ioBroker ne les renomme pas dans Gladys.

## Confidentialité

Tout reste sur votre réseau : Gladys ne parle qu'à l'adaptateur rest-api. Le mot de passe est stocké
dans la configuration de Gladys et n'est jamais écrit dans les journaux.
