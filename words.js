const WORDS = [
  "amour","arbre","avion","banc","bazar","beurre","bouteille","bureau","cahier","canard","chaise",
  "chanson","cheval","citron","clavier","coeur","colline","couleur","courant","danse","drapeau",
  "école","écran","étoile","fenêtre","fleur","fromage","glace","heure","histoire","jardin","joueur",
  "lumière","machine","maison","manger","montagne","mouette","musique","nuit","orange","orage",
  "papier","parfum","plage","pluie","poche","pont","porte","poule","poussière","prénom","queue",
  "radio","rivière","rose","salade","savon","saison","silence","soleil","sourire","table","tapis",
  "terre","train","travail","vague","valise","vent","verre","voiture","zèbre","abricot","agneau",
  "alcool","alphabet","argent","asile","atelier","auberge","automne","ballon","banane","barque",
  "bassin","batterie","bétail","blouse","bonbon","bouchon","bougie","brouillard","cactus","camion",
  "carré","carton","cascade","ceinture","cerise","champ","chapeau","chêne","chemin","cheville",
  "chocolat","ciel","cigogne","cinéma","cité","cloche","cochon","colère","compte","confiance","corbeau",
  "coucher","croissant","décor","désert","digue","dossier","écureuil","énergie","enfant","épée",
  "escalier","espoir","étude","famille","farine","fête","filet","flamme","garage","gâteau","givre",
  "grenouille","guitare","haricot","horizon","hôtel","image","important","insecte","joli","journal",
  "justice","lagune","lampe","lettre","liberté","ligne","livre","logique","magie","marbre",
  "marché","mariage","matin","météo","miracle","moteur","murmure","nature","navire","nuage","objet",
  "océan","oiseau","optique","oranger","ouest","palette","panier","parc","passage","paysage","peinture",
  "pelouse","pendule","pierre","pincette","piscine","piston","planète","plume","poisson","pommier",
  "poumon","principe","projet","promenade","puissance","quai","quartier","quatre",
  "rêve","relais","renard","réponse","route","ruche","sable","saison","sang","sapin","savane","science",
  "serpent","souffle","spectacle","statue","stylo","sucre","sujet","tampon","téléphone",
  "timbre","torrent","tortue","tournesol","trésor","univers","vacances","village","vision","zéro",
  "abeille","acacia","adulte","aigle","alarme","album","algue","ananas","anneau","antilope","aurore",
  "bagage","balle","banlieue","basilic","beige","biscuit","blanc","bleu","bois","boussole","bronze",
  "brume","cabane","cadre","calme","canyon","capuchon","carte","cerf","champagne","charbon","chaton",
  "chiffre","chute","cirque","ciseau","citadelle","clair","climat","cobalt","compas","corde","coton",
  "couloir","crayon","crête","croûte","cuisine","cygne","dauphin","détail","diamant","dinosaure","doigt",
  "domino","éclair","écharpe","effort","église","élastique","émeraude","endroit","enseigne","escalade",
  "essai","éveil","façade","faucon","fermeté","ficelle","fjord","flocon","forteresse","framboise",
  "friture","gazon","gerbe","glaçon","goéland","gorge","grange","gravier","griffe","grotte","hameau",
  "harpe","hélice","herbe","hibou","homard","iceberg","indigo","industrie","iris","isthme","jasmin",
  "kiosque","lacune","laine","lierre","limonade","lion","liseron","magma","manteau","marguerite","marée",
  "mastic","méduse","miel","minuit","moisson","monture","mosaïque","moulin","mousson","mousse","navet",
  "niche","noisette","octogone","officier","ondée","opale","orangeade","orque","orchidée","outil","palais",
  "panneau","parapluie","parution","pâturage","pétale","phares","phare","piano","pilier","piment",
  "plaisir","pochette","poivron","police","pompe","portrait","prisme","profondeur","puzzle",
  "quartz","radis","rampe","rappel","rayon","rectangle","relique","rempart","requin","rideau","ruban",
  "sarcelle","sardine","saturne","sauvage","scène","sifflet","sillage","sirène","socle","sommet","sphère",
  "spatule","squelette","stade","station","stéréo","sud","symbole","tabouret","taureau","tempête",
  "tesson","théâtre","tige","tomate","tonnerre","trombone","tuyau","tuyère","unique","usine","vallée",
  "veille","velours","verger","vernis","vertige","vigne","voilier","voyage","wagon",
  "mario","luigi","peach","bowser","yoshi","zelda","link","kirby","sonic","samus",
  "metroid","minecraft","tetris","pacman","pokemon","donkey","kratos","ellie","cortana","masterchief",
  "vaultboy","squall","sephiroth","cloud","nintendo","playstation","xbox","roblox","fortnite","moba"
];

function normalizeWord(value) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export function createSeededRng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(...parts) {
  const source = parts.join("|");
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function sampleWords(count, seed = Date.now()) {
  const unique = [...new Set(
    WORDS
      .map((word) => word.trim())
      .filter(Boolean)
      .filter((word) => /^[A-Za-z0-9À-ÿ]+$/.test(word))
  )];
  const pool = [...unique];
  const rng = createSeededRng(hashSeed(seed, unique.length, count));
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

export function normalizeGuess(value) {
  return normalizeWord(value);
}

export function getDisplayWord(word) {
  return word;
}
