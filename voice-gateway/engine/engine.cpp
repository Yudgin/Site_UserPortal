// sip-engine — SIP-рушій голосового шлюзу Binotel на pjsua2.
// Команди — JSON-рядки зі stdin, події — JSON-рядки у stdout, журнал — тільки stderr.
// Один потік: threadCnt=0, mainThreadOnly; цикл чергує select(stdin) і libHandleEvents.
// Номери викликів — власні зростаючі цілі рушія (не індекси pjsua), тож не повторюються.

#include <pjsua2.hpp>

#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <signal.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <vector>

using namespace pj;
using Clock = std::chrono::steady_clock;

// ---------- вивід ----------

static int g_evfd = -1;  // справжній stdout (тільки події)
static std::mutex g_outMu;

static void writeAll(int fd, const char *p, size_t n) {
  while (n > 0) {
    ssize_t w = ::write(fd, p, n);
    if (w < 0) {
      if (errno == EINTR) continue;
      return;  // EPIPE тощо: мозок зник, мовчки ігноруємо
    }
    p += w;
    n -= (size_t)w;
  }
}

static void logf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void logf(const char *fmt, ...) {
  char buf[2048];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  if (n < 0) return;
  if ((size_t)n >= sizeof buf) n = (int)sizeof buf - 1;
  std::string s = "[engine] ";
  s.append(buf, (size_t)n);
  s += '\n';
  writeAll(2, s.data(), s.size());
}

// JSON-рядок; некоректний UTF-8 замінюємо на U+FFFD
static std::string jsonQuote(const std::string &in) {
  std::string o;
  o.reserve(in.size() + 2);
  o += '"';
  size_t i = 0, n = in.size();
  while (i < n) {
    unsigned char c = (unsigned char)in[i];
    if (c < 0x80) {
      switch (c) {
        case '"': o += "\\\""; break;
        case '\\': o += "\\\\"; break;
        case '\n': o += "\\n"; break;
        case '\r': o += "\\r"; break;
        case '\t': o += "\\t"; break;
        default:
          if (c < 0x20 || c == 0x7f) {
            char b[8];
            snprintf(b, sizeof b, "\\u%04x", c);
            o += b;
          } else {
            o += (char)c;
          }
      }
      i++;
      continue;
    }
    size_t len = (c >= 0xc2 && c <= 0xdf) ? 2 : (c >= 0xe0 && c <= 0xef) ? 3 : (c >= 0xf0 && c <= 0xf4) ? 4 : 0;
    bool ok = len > 0 && i + len <= n;
    for (size_t k = 1; ok && k < len; k++)
      if (((unsigned char)in[i + k] & 0xc0) != 0x80) ok = false;
    if (ok) {
      o.append(in, i, len);
      i += len;
    } else {
      o += "\\ufffd";
      i++;
    }
  }
  o += '"';
  return o;
}

// Події виклику, що створюється, притримуємо, поки не вийде 'dialing'
static int g_holdEid = 0;
static std::vector<std::string> g_held;

class Ev {
 public:
  explicit Ev(const char *name) { str("ev", name); }
  Ev &str(const char *k, const std::string &v) { key(k); b_ += jsonQuote(v); return *this; }
  Ev &strOrNull(const char *k, const std::string &v) { return v.empty() ? null(k) : str(k, v); }
  Ev &num(const char *k, long long v) { key(k); b_ += std::to_string(v); return *this; }
  Ev &boolean(const char *k, bool v) { key(k); b_ += v ? "true" : "false"; return *this; }
  Ev &real(const char *k, double v) {
    char b[32];
    snprintf(b, sizeof b, "%.2f", std::isfinite(v) ? v : 0.0);
    key(k);
    b_ += b;
    return *this;
  }
  Ev &null(const char *k) { key(k); b_ += "null"; return *this; }
  Ev &call(int eid) {
    callId_ = eid;
    return eid > 0 ? num("call", eid) : null("call");
  }
  void emit() {
    std::string line = b_ + "}\n";
    if (g_holdEid != 0 && callId_ == g_holdEid) {
      g_held.push_back(line);
      return;
    }
    std::lock_guard<std::mutex> g(g_outMu);
    writeAll(g_evfd, line.data(), line.size());
  }

 private:
  void key(const char *k) {
    b_ += first_ ? "{" : ",";
    first_ = false;
    b_ += jsonQuote(k);
    b_ += ':';
  }
  std::string b_;
  bool first_ = true;
  int callId_ = 0;
};

static void emitError(const std::string &cmd, int eid, const std::string &ref, const std::string &msg) {
  Ev e("error");
  e.strOrNull("cmd", cmd).call(eid).strOrNull("ref", ref).str("msg", msg).emit();
  logf("error cmd=%s call=%d: %s", cmd.c_str(), eid, msg.c_str());
}

// ---------- мінімальний розбір JSON (плаский об'єкт команди) ----------

struct JVal {
  enum Type { Null, Bool, Num, Str, Other } t = Null;
  bool b = false;
  double n = 0;
  std::string s;
};
using JObj = std::map<std::string, JVal>;

class JParser {
 public:
  explicit JParser(const std::string &s) : s_(s) {}

  bool object(JObj &out) {
    ws();
    if (!eat('{')) return false;
    ws();
    if (eat('}')) return atEnd();
    for (;;) {
      ws();
      std::string k;
      if (!str(k)) return false;
      ws();
      if (!eat(':')) return false;
      ws();
      JVal v;
      if (!value(v, 1)) return false;
      out[k] = v;
      ws();
      if (eat(',')) continue;
      if (eat('}')) return atEnd();
      return false;
    }
  }

 private:
  bool atEnd() {
    ws();
    return i_ == s_.size();
  }
  void ws() {
    while (i_ < s_.size() && (s_[i_] == ' ' || s_[i_] == '\t' || s_[i_] == '\r' || s_[i_] == '\n')) i_++;
  }
  bool eat(char c) {
    if (i_ < s_.size() && s_[i_] == c) {
      i_++;
      return true;
    }
    return false;
  }
  bool lit(const char *w) {
    size_t L = strlen(w);
    if (s_.compare(i_, L, w) == 0) {
      i_ += L;
      return true;
    }
    return false;
  }
  static void utf8(std::string &o, unsigned cp) {
    if (cp < 0x80) {
      o += (char)cp;
    } else if (cp < 0x800) {
      o += (char)(0xc0 | (cp >> 6));
      o += (char)(0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      o += (char)(0xe0 | (cp >> 12));
      o += (char)(0x80 | ((cp >> 6) & 0x3f));
      o += (char)(0x80 | (cp & 0x3f));
    } else {
      o += (char)(0xf0 | (cp >> 18));
      o += (char)(0x80 | ((cp >> 12) & 0x3f));
      o += (char)(0x80 | ((cp >> 6) & 0x3f));
      o += (char)(0x80 | (cp & 0x3f));
    }
  }
  bool hex4(unsigned &v) {
    if (i_ + 4 > s_.size()) return false;
    v = 0;
    for (int k = 0; k < 4; k++) {
      char c = s_[i_++];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
      else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
      else return false;
    }
    return true;
  }
  bool str(std::string &o) {
    if (!eat('"')) return false;
    while (i_ < s_.size()) {
      char c = s_[i_++];
      if (c == '"') return true;
      if ((unsigned char)c < 0x20) return false;
      if (c != '\\') {
        o += c;
        continue;
      }
      if (i_ >= s_.size()) return false;
      char e = s_[i_++];
      switch (e) {
        case '"': o += '"'; break;
        case '\\': o += '\\'; break;
        case '/': o += '/'; break;
        case 'b': o += '\b'; break;
        case 'f': o += '\f'; break;
        case 'n': o += '\n'; break;
        case 'r': o += '\r'; break;
        case 't': o += '\t'; break;
        case 'u': {
          unsigned cp;
          if (!hex4(cp)) return false;
          if (cp >= 0xd800 && cp <= 0xdbff) {
            unsigned lo = 0;
            if (i_ + 1 < s_.size() && s_[i_] == '\\' && s_[i_ + 1] == 'u') {
              i_ += 2;
              if (!hex4(lo)) return false;
              cp = (lo >= 0xdc00 && lo <= 0xdfff) ? 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00) : 0xfffd;
            } else {
              cp = 0xfffd;
            }
          } else if (cp >= 0xdc00 && cp <= 0xdfff) {
            cp = 0xfffd;
          }
          utf8(o, cp);
          break;
        }
        default: return false;
      }
    }
    return false;
  }
  bool value(JVal &v, int depth) {
    if (depth > 32 || i_ >= s_.size()) return false;
    char c = s_[i_];
    if (c == '"') {
      v.t = JVal::Str;
      return str(v.s);
    }
    if (c == '{' || c == '[') {
      v.t = JVal::Other;
      return composite(depth);
    }
    if (lit("true")) { v.t = JVal::Bool; v.b = true; return true; }
    if (lit("false")) { v.t = JVal::Bool; v.b = false; return true; }
    if (lit("null")) { v.t = JVal::Null; return true; }
    if (c != '-' && (c < '0' || c > '9')) return false;
    const char *b = s_.c_str() + i_;
    char *e = nullptr;
    double d = strtod(b, &e);
    if (e == b) return false;
    i_ += (size_t)(e - b);
    v.t = JVal::Num;
    v.n = d;
    return true;
  }
  bool composite(int depth) {  // вкладене пропускаємо
    char open = s_[i_++];
    char close = open == '{' ? '}' : ']';
    ws();
    if (eat(close)) return true;
    for (;;) {
      ws();
      if (open == '{') {
        std::string k;
        if (!str(k)) return false;
        ws();
        if (!eat(':')) return false;
        ws();
      }
      JVal v;
      if (!value(v, depth + 1)) return false;
      ws();
      if (eat(',')) continue;
      if (eat(close)) return true;
      return false;
    }
  }

  const std::string &s_;
  size_t i_ = 0;
};

static bool getStr(const JObj &o, const char *k, std::string &out) {
  auto it = o.find(k);
  if (it == o.end() || it->second.t != JVal::Str) return false;
  out = it->second.s;
  return true;
}
static bool getInt(const JObj &o, const char *k, long long &out) {
  auto it = o.find(k);
  if (it == o.end() || it->second.t != JVal::Num) return false;
  double d = it->second.n;
  if (!std::isfinite(d) || d != std::floor(d) || std::fabs(d) > 9e15) return false;
  out = (long long)d;
  return true;
}
static bool getBool(const JObj &o, const char *k, bool dflt) {
  auto it = o.find(k);
  if (it == o.end()) return dflt;
  if (it->second.t == JVal::Bool) return it->second.b;
  if (it->second.t == JVal::Num) return it->second.n != 0;
  return dflt;
}
static bool has(const JObj &o, const char *k) {
  auto it = o.find(k);
  return it != o.end() && it->second.t != JVal::Null;
}

// ---------- розбір SIP-рядків ----------

static std::string trim(const std::string &s) {
  size_t a = 0, b = s.size();
  while (a < b && (s[a] == ' ' || s[a] == '\t' || s[a] == '\r' || s[a] == '\n')) a++;
  while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t' || s[b - 1] == '\r' || s[b - 1] == '\n')) b--;
  return s.substr(a, b - a);
}

static bool ieq(const std::string &a, const char *b) {
  size_t n = strlen(b);
  if (a.size() != n) return false;
  for (size_t i = 0; i < n; i++)
    if (tolower((unsigned char)a[i]) != tolower((unsigned char)b[i])) return false;
  return true;
}

// Значення заголовка з повного тексту повідомлення (без урахування регістру назви)
static std::string findHeader(const std::string &msg, const char *name) {
  size_t pos = 0;
  bool firstLine = true;
  while (pos < msg.size()) {
    size_t eol = msg.find('\n', pos);
    if (eol == std::string::npos) eol = msg.size();
    std::string line = msg.substr(pos, eol - pos);
    pos = eol + 1;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty()) break;  // кінець заголовків
    if (firstLine) {
      firstLine = false;
      continue;
    }
    size_t colon = line.find(':');
    if (colon == std::string::npos) continue;
    if (ieq(trim(line.substr(0, colon)), name)) return trim(line.substr(colon + 1));
  }
  return std::string();
}

// "Ім'я" <sip:user@host;x> → ім'я та URI
static void parseNameAddr(const std::string &in, std::string &display, std::string &uri) {
  std::string s = trim(in);
  display.clear();
  uri.clear();
  size_t lt = s.find('<');
  if (lt == std::string::npos) {
    size_t semi = s.find(';');
    uri = trim(semi == std::string::npos ? s : s.substr(0, semi));
    return;
  }
  size_t gt = s.find('>', lt);
  uri = trim(s.substr(lt + 1, gt == std::string::npos ? std::string::npos : gt - lt - 1));
  std::string d = trim(s.substr(0, lt));
  if (d.size() >= 2 && d.front() == '"' && d.back() == '"') {
    std::string u;
    for (size_t i = 1; i + 1 < d.size(); i++) {
      if (d[i] == '\\' && i + 2 < d.size()) i++;
      u += d[i];
    }
    d = u;
  }
  display = d;
}

// user-частина URI: sip:0500000001@host → 0500000001
static std::string uriUser(const std::string &uri) {
  std::string s = uri;
  size_t colon = s.find(':');
  if (colon != std::string::npos) {
    std::string scheme = s.substr(0, colon);
    if (ieq(scheme, "sip") || ieq(scheme, "sips") || ieq(scheme, "tel")) s = s.substr(colon + 1);
  }
  size_t at = s.find('@');
  if (at == std::string::npos) return ieq(uri.substr(0, 4), "tel:") ? s.substr(0, s.find(';')) : std::string();
  std::string user = s.substr(0, at);
  size_t semi = user.find(';');
  if (semi != std::string::npos) user = user.substr(0, semi);
  return user;
}

// IP без порту: "1.2.3.4:5060" → "1.2.3.4", "[::1]:5060" → "::1", "sip14.binotel.com" → як є
static std::string hostOf(const std::string &a) {
  if (!a.empty() && a[0] == '[') {
    size_t e = a.find(']');
    return e == std::string::npos ? a.substr(1) : a.substr(1, e - 1);
  }
  size_t c = a.rfind(':');
  if (c != std::string::npos && a.find(':') == c) return a.substr(0, c);
  return a;
}

// Для журналу рушія: лише останні 4 символи номера (номери клієнтів у лог не пишемо)
static std::string maskTail(const std::string &n) {
  if (n.empty()) return "-";
  return n.size() <= 4 ? std::string("…") + n : std::string("…") + n.substr(n.size() - 4);
}

// URI для журналу рушія: user-частину з 5+ цифр (номер телефону — клієнта на передзвоні, мобільний менеджера)
// замінюємо останніми 4 цифрами: «sip:0501234567@sip14.binotel.com;transport=udp» → «sip:…4567@sip14.binotel.com;…».
// Внутрішні лінії (907) і нецифрові імена лишаються як є — так лог зручніше читати.
static std::string maskUri(const std::string &uri) {
  std::string user = uriUser(uri);
  int digits = 0;
  for (char ch : user) digits += (ch >= '0' && ch <= '9');
  if (digits < 5) return uri;
  size_t colon = uri.find(':');
  size_t at = uri.find('@');
  std::string scheme = colon == std::string::npos ? std::string() : uri.substr(0, colon + 1);
  if (at == std::string::npos) return scheme + maskTail(user);  // tel:+380… — без хоста
  return scheme + maskTail(user) + uri.substr(at);
}

// ---------- стан ----------

class GwCall;
class GwPlayer;
class GwAccount;
class GwAudio;

struct CallRec {
  int eid = 0;
  GwCall *call = nullptr;
  bool outgoing = false;
  std::string ref;
  bool mediaActive = false;
  bool ended = false;
  GwPlayer *player = nullptr;
  bool playerOn = false;  // програвач уже передає у дзвінок
  int bridgePeer = 0;
  bool silent = false;    // відхилений рушієм (чужа адреса): мозку про нього не повідомляємо
  AudioMediaRecorder *rec = nullptr;  // запис голосу співрозмовника (голосова пошта)
  bool recOn = false;                 // звук виклику вже йде в запис
  std::string recFile;
  GwAudio *audio = nullptr;  // потік звуку до мозку (ШІ-співрозмовник), команда audio_start
  bool audioOn = false;      // порт уже під'єднаний до звуку виклику в обидва боки
  // Остання цифра DTMF: pjsua2 може повідомити те саме натискання двома колбеками (onDtmfDigit і onDtmfEvent)
  std::string dtmfDigit;
  int dtmfMethod = -1;
  int dtmfSrc = 0;  // 1 — onDtmfDigit, 2 — onDtmfEvent
  Clock::time_point dtmfAt;
};

static Endpoint *g_ep = nullptr;
static GwAccount *g_acc = nullptr;
static bool g_realMode = false;
static bool g_regActive = false;
static bool g_regEvent = false;
// Реальний режим: INVITE приймаємо лише з цих IP — адреси сервера з DNS, звідки прийшов 2xx на REGISTER,
// і додані командою register (поле trust). Транспорт слухає 0.0.0.0, тож без цього дзвонити міг би будь-хто.
static std::set<std::string> g_trusted;

static void trustAdd(const std::string &ip, const char *why) {
  if (ip.empty() || g_trusted.count(ip)) return;
  g_trusted.insert(ip);
  logf("trusted source %s (%s)", ip.c_str(), why);
}

static void trustResolve(const std::string &host) {
  struct addrinfo hints;
  memset(&hints, 0, sizeof hints);
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_DGRAM;
  struct addrinfo *res = nullptr;
  int rc = getaddrinfo(host.c_str(), nullptr, &hints, &res);
  if (rc != 0) {
    logf("resolve %s failed: %s (trusted sources: registrar reply only)", host.c_str(), gai_strerror(rc));
    return;
  }
  for (struct addrinfo *ai = res; ai; ai = ai->ai_next) {
    char buf[INET6_ADDRSTRLEN] = {0};
    const void *src = ai->ai_family == AF_INET ? (const void *)&((struct sockaddr_in *)ai->ai_addr)->sin_addr
                                               : (const void *)&((struct sockaddr_in6 *)ai->ai_addr)->sin6_addr;
    if (inet_ntop(ai->ai_family, src, buf, sizeof buf)) trustAdd(buf, "dns");
  }
  freeaddrinfo(res);
}
static volatile sig_atomic_t g_signal = 0;
static bool g_quit = false;
static int g_nextEid = 1;
static std::map<int, CallRec> g_calls;
static std::vector<int> g_deadCalls;
static std::vector<int> g_rejectQ;  // вхідні з чужих адрес: відповісти 403
// Від'єднаний програвач видаляємо із запізненням: запізнілий onEof2 із потоку подій
// pjmedia ще може дістатися до об'єкта
struct DeadPlayer {
  GwPlayer *p;
  Clock::time_point at;
};
static std::vector<DeadPlayer> g_deadPlayers;
static const auto kPlayerLinger = std::chrono::milliseconds(1000);

// Запис, що закривається: об'єкт видаляємо в головному циклі, а WAV дописує (заголовок із довжиною) потік мосту —
// видалення порту з конференції асинхронне. record_done шлемо, коли заголовок оновився, або через kRecFinalWait.
struct DeadRec {
  AudioMediaRecorder *rec;
  int eid;
  std::string file;
  std::string why;
};
static std::vector<DeadRec> g_deadRecs;
struct ClosingRec {
  int eid;
  std::string file;
  std::string why;
  Clock::time_point at;
};
static std::vector<ClosingRec> g_closingRecs;
static const auto kRecFinalWait = std::chrono::milliseconds(1500);

// Кінець файлу програвача: колбек приходить з медіапотоку, тож лише черга
struct EofNote {
  int eid;
  unsigned long long gen;
};
static std::mutex g_eofMu;
static std::vector<EofNote> g_eofQ;
static unsigned long long g_genCounter = 0;

class GwPlayer : public AudioMediaPlayer {
 public:
  GwPlayer(int eid, const std::string &tag, bool loop) : eid_(eid), gen_(++g_genCounter), tag_(tag), loop_(loop) {}
  void onEof2() override {
    if (loop_) return;
    std::lock_guard<std::mutex> g(g_eofMu);
    g_eofQ.push_back({eid_, gen_});
  }
  unsigned long long gen() const { return gen_; }
  const std::string &tag() const { return tag_; }

 private:
  const int eid_;
  const unsigned long long gen_;
  const std::string tag_;
  const bool loop_;
};

// ---------- звук виклику ↔ мозок (ШІ-співрозмовник) ----------
// audio_start: рушій під'єднується до Unix-сокета мозку (шлях і токен дає мозок) і пускає звук виклику в обидва боки.
// Перший рядок від рушія — JSON {"token":"…","call":N,"rate":R}\n (мозок за ним зіставляє з'єднання з дзвінком), далі
// кадри: 1 байт типу + u32 LE довжина + дані.
//   рушій → мозок: 'A' голос співрозмовника, PCM16LE моно, кадр 20 мс на частоті порту (немає звуку — тиша);
//                  'M' u32 id + u32 відтворено — мітку мозку дограно;
//                  'K' u32 відтворено + u32 скинуто — чергу скинуто (відповідь на 'C').
//   мозок → рушій: 'A' PCM16LE для відтворення (будь-якої довжини), 'C' скинути чергу (співрозмовник перебив),
//                  'M' u32 id — мітка в кінці того, що вже в черзі (дограно — рушій повертає 'M').
// «Відтворено» — скільки семплів узято з черги від початку з'єднання (тиша-заповнювач не рахується), mod 2^32.
// Колбеки порту приходять із медіапотоку моста конференції, а не з головного: черга й вихідний буфер під м'ютексом,
// сокет неблокувальний. Мозок не читає — вихідний буфер обмежений, зайві кадри голосу відкидаємо (лічильник).
static const size_t kAudioOutMax = 512 * 1024;  // вихідний буфер до мозку
static const uint32_t kAudioFrameMax = 1u << 20; // найдовший кадр від мозку
static const unsigned kAudioQueueSec = 180;     // черга відтворення — не довше

static void putU32(std::string &s, uint32_t v) {
  for (int i = 0; i < 4; i++) s += (char)((v >> (8 * i)) & 0xff);
}
static uint32_t getU32(const char *p) {
  const unsigned char *u = (const unsigned char *)p;
  return (uint32_t)u[0] | ((uint32_t)u[1] << 8) | ((uint32_t)u[2] << 16) | ((uint32_t)u[3] << 24);
}

class GwAudio : public AudioMediaPort {
 public:
  GwAudio(int eid, int fd, unsigned rate) : eid_(eid), fd_(fd), rate_(rate), spf_(rate / 50) {}
  ~GwAudio() override {
    std::lock_guard<std::mutex> g(mu_);
    closeFdLocked();
  }
  int fd() {
    std::lock_guard<std::mutex> g(mu_);
    return fd_;
  }
  unsigned rate() const { return rate_; }
  int eid() const { return eid_; }

  // Медіапотік: наступні 20 мс для співрозмовника — з черги мозку; черга порожня — кадру немає (міст дає тишу)
  void onFrameRequested(MediaFrame &f) override {
    std::lock_guard<std::mutex> g(mu_);
    size_t have = q_.size() - rd_;
    if (closed_ || have == 0 || f.size < 2) {
      f.type = PJMEDIA_FRAME_TYPE_NONE;
      return;
    }
    size_t want = f.size / 2;
    size_t n = std::min(want, have);
    f.buf.assign(want * 2, 0);  // недобір наприкінці — тиша
    memcpy(f.buf.data(), q_.data() + rd_, n * 2);
    f.type = PJMEDIA_FRAME_TYPE_AUDIO;
    rd_ += n;
    played_ += n;
    if (rd_ == q_.size()) {
      q_.clear();
      rd_ = 0;
    } else if (rd_ > (size_t)rate_ * 4 && rd_ * 2 > q_.size()) {
      q_.erase(q_.begin(), q_.begin() + (long)rd_);
      rd_ = 0;
    }
    while (!marks_.empty() && marks_.front().first <= played_) {
      outMark(marks_.front().second);
      marks_.erase(marks_.begin());
    }
    flushLocked();
  }

  // Медіапотік: голос співрозмовника → мозку (без звуку — тиша того ж розміру: мозку потрібен безперервний потік)
  void onFrameReceived(MediaFrame &f) override {
    std::lock_guard<std::mutex> g(mu_);
    if (closed_ || fd_ < 0) return;
    size_t n = f.buf.empty() ? (size_t)spf_ * 2 : f.buf.size();
    if (out_.size() + n + 5 > kAudioOutMax) {
      droppedOut_++;
      return;
    }
    out_ += 'A';
    putU32(out_, (uint32_t)n);
    if (f.buf.empty() || f.type != PJMEDIA_FRAME_TYPE_AUDIO) out_.append(n, '\0');
    else out_.append((const char *)f.buf.data(), n);
    flushLocked();
  }

  // Головний потік: перший рядок для мозку (до будь-якого кадру)
  void hello(const std::string &line) {
    std::lock_guard<std::mutex> g(mu_);
    out_.insert(0, line);
    flushLocked();
  }

  // Головний потік: прочитати все, що прийшло від мозку. false — мозок закрив з'єднання, помилка сокета чи протоколу.
  bool pump() {
    char buf[16384];
    for (;;) {
      int fd = this->fd();
      if (fd < 0) return false;
      ssize_t k = recv(fd, buf, sizeof buf, 0);
      if (k > 0) {
        in_.append(buf, (size_t)k);
        if (!parse()) return false;
        if ((size_t)k < sizeof buf) break;
        continue;
      }
      if (k == 0) return false;
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) break;
      return false;
    }
    std::lock_guard<std::mutex> g(mu_);
    flushLocked();
    return !broken_;
  }

  bool wantWrite() {
    std::lock_guard<std::mutex> g(mu_);
    return fd_ >= 0 && !out_.empty();
  }
  void flush() {
    std::lock_guard<std::mutex> g(mu_);
    flushLocked();
  }
  bool broken() {
    std::lock_guard<std::mutex> g(mu_);
    return broken_;
  }
  // Головний потік: зняти порт із моста конференції одразу (видалення з моста асинхронне — об'єкт видаляємо пізніше,
  // коли міст його вже точно не викликає; деструктор AudioMediaPort повторне зняття пропускає)
  void detach() {
    try {
      unregisterMediaPort();
    } catch (Error &) {
    }
  }
  // Більше не грати й не слати: колбеки моста, що ще прийдуть, нічого не роблять; сокет закриваємо одразу
  void shut(unsigned long long &played, unsigned long long &queued, unsigned long long &droppedOut) {
    std::lock_guard<std::mutex> g(mu_);
    closed_ = true;
    played = played_;
    queued = q_.size() - rd_;
    droppedOut = droppedOut_;
    q_.clear();
    rd_ = 0;
    marks_.clear();
    flushLocked();
    closeFdLocked();
  }

 private:
  void outMark(uint32_t id) {
    out_ += 'M';
    putU32(out_, 8);
    putU32(out_, id);
    putU32(out_, (uint32_t)played_);
  }
  void flushLocked() {
    while (fd_ >= 0 && !out_.empty()) {
      ssize_t w = send(fd_, out_.data(), out_.size(), 0);
      if (w > 0) {
        out_.erase(0, (size_t)w);
        continue;
      }
      if (w < 0 && errno == EINTR) continue;
      if (w < 0 && errno != EAGAIN && errno != EWOULDBLOCK) broken_ = true;
      break;
    }
  }
  void closeFdLocked() {
    if (fd_ < 0) return;
    ::close(fd_);
    fd_ = -1;
  }
  // Кадри від мозку з in_; false — порушення протоколу (кадр завеликий)
  bool parse() {
    size_t off = 0;
    bool ok = true;
    while (in_.size() - off >= 5) {
      char type = in_[off];
      uint32_t len = getU32(in_.data() + off + 1);
      if (len > kAudioFrameMax) {
        ok = false;
        break;
      }
      if (in_.size() - off - 5 < len) break;
      const char *p = in_.data() + off + 5;
      std::lock_guard<std::mutex> g(mu_);
      if (type == 'A') {
        size_t n = len / 2;
        size_t cap = (size_t)rate_ * kAudioQueueSec;
        size_t queued = q_.size() - rd_;
        if (queued + n > cap) {
          droppedIn_ += queued + n - cap;
          n = queued < cap ? cap - queued : 0;
        }
        if (n) {
          size_t at = q_.size();
          q_.resize(at + n);
          memcpy(q_.data() + at, p, n * 2);
        }
      } else if (type == 'C') {
        uint32_t dropped = (uint32_t)(q_.size() - rd_);
        q_.clear();
        rd_ = 0;
        marks_.clear();
        out_ += 'K';
        putU32(out_, 8);
        putU32(out_, (uint32_t)played_);
        putU32(out_, dropped);
      } else if (type == 'M' && len == 4) {
        uint32_t id = getU32(p);
        unsigned long long pos = played_ + (q_.size() - rd_);
        if (pos <= played_) outMark(id);
        else marks_.push_back({pos, id});
      }  // невідомі типи — пропускаємо (сумісність із новішим мозком)
      off += 5 + len;
    }
    in_.erase(0, off);
    if (!ok) return false;
    std::lock_guard<std::mutex> g(mu_);
    flushLocked();
    return true;
  }

  const int eid_;
  int fd_;
  const unsigned rate_;
  const unsigned spf_;  // семплів у кадрі 20 мс
  std::mutex mu_;
  std::vector<int16_t> q_;  // черга відтворення (PCM16 на частоті порту)
  size_t rd_ = 0;
  unsigned long long played_ = 0;
  std::vector<std::pair<unsigned long long, uint32_t>> marks_;  // позиція (відтворено) → id мітки
  std::string out_;  // до мозку
  std::string in_;   // від мозку, ще не розібране (лише головний потік)
  bool closed_ = false;
  bool broken_ = false;
  unsigned long long droppedOut_ = 0;  // кадрів голосу, які не влізли у вихідний буфер
  unsigned long long droppedIn_ = 0;   // семплів, які не влізли в чергу відтворення
};

// Від'єднаний порт видаляємо із запізненням, як програвач: колбек моста ще може прийти
struct DeadAudio {
  GwAudio *a;
  Clock::time_point at;
};
static std::vector<DeadAudio> g_deadAudios;

static CallRec *findRec(int eid) {
  auto it = g_calls.find(eid);
  return it == g_calls.end() ? nullptr : &it->second;
}

static const char *stateName(pjsip_inv_state s) {
  switch (s) {
    case PJSIP_INV_STATE_NULL: return "NULL";
    case PJSIP_INV_STATE_CALLING: return "CALLING";
    case PJSIP_INV_STATE_INCOMING: return "INCOMING";
    case PJSIP_INV_STATE_EARLY: return "EARLY";
    case PJSIP_INV_STATE_CONNECTING: return "CONNECTING";
    case PJSIP_INV_STATE_CONFIRMED: return "CONFIRMED";
    case PJSIP_INV_STATE_DISCONNECTED: return "DISCONNECTED";
  }
  return "UNKNOWN";
}

class GwCall : public Call {
 public:
  GwCall(Account &acc, int eid, int pjid = PJSUA_INVALID_ID) : Call(acc, pjid), eid_(eid) {}
  int eid() const { return eid_; }
  void onCallState(OnCallStateParam &prm) override;
  void onCallMediaState(OnCallMediaStateParam &prm) override;
  void onCallSdpCreated(OnCallSdpCreatedParam &prm) override;
  void onCallTransferStatus(OnCallTransferStatusParam &prm) override;
  void onCallTransferRequest(OnCallTransferRequestParam &prm) override;
  void onCallReplaceRequest(OnCallReplaceRequestParam &prm) override;
  void onDtmfDigit(OnDtmfDigitParam &prm) override;
  void onDtmfEvent(OnDtmfEventParam &prm) override;

 private:
  const int eid_;
};

// Програвач більше не потрібен: від'єднати й віддати на видалення в головному циклі
static void dropPlayer(CallRec &r) {
  if (!r.player) return;
  if (r.playerOn && !r.ended && r.mediaActive && r.call) {
    try {
      AudioMedia am = r.call->getAudioMedia(-1);
      r.player->stopTransmit(am);
    } catch (Error &) {
    }
  }
  g_deadPlayers.push_back({r.player, Clock::now()});
  r.player = nullptr;
  r.playerOn = false;
}

static void startPlayer(CallRec &r) {
  if (!r.player || r.playerOn || r.ended || !r.mediaActive || !r.call) return;
  try {
    AudioMedia am = r.call->getAudioMedia(-1);
    r.player->startTransmit(am);
    r.playerOn = true;
  } catch (Error &e) {
    logf("call %d: player start failed: %s", r.eid, e.reason.c_str());
  }
}

// Запис: звук виклику (голос співрозмовника) → рекордер; якщо медіа ще немає — під'єднаємо в onCallMediaState.
// false і причина в why — під'єднати не вдалося (медіа є, а startTransmit кинув виняток).
static bool startRecorder(CallRec &r, std::string *why = nullptr) {
  if (!r.rec || r.recOn || r.ended || !r.mediaActive || !r.call) return false;
  try {
    AudioMedia am = r.call->getAudioMedia(-1);
    am.startTransmit(*r.rec);
    r.recOn = true;
    return true;
  } catch (Error &e) {
    logf("call %d: recorder start failed: %s", r.eid, e.reason.c_str());
    if (why) *why = e.reason.empty() ? e.info() : e.reason;
    return false;
  }
}

// Запис більше не потрібен (record_stop, кінець виклику, вихід): від'єднати й віддати на закриття в головному циклі
static void dropRecorder(CallRec &r, const char *why) {
  if (!r.rec) return;
  if (r.recOn && !r.ended && r.mediaActive && r.call) {
    try {
      AudioMedia am = r.call->getAudioMedia(-1);
      am.stopTransmit(*r.rec);
    } catch (Error &) {
    }
  }
  g_deadRecs.push_back({r.rec, r.eid, r.recFile, why});
  r.rec = nullptr;
  r.recOn = false;
  r.recFile.clear();
}

// Потік звуку до мозку: звук виклику → порт і порт → виклик; медіа ще немає — під'єднаємо в onCallMediaState
static void startAudio(CallRec &r) {
  if (!r.audio || r.audioOn || r.ended || !r.mediaActive || !r.call) return;
  try {
    AudioMedia am = r.call->getAudioMedia(-1);
    am.startTransmit(*r.audio);
    r.audio->startTransmit(am);
    r.audioOn = true;
  } catch (Error &e) {
    logf("call %d: audio stream start failed: %s", r.eid, e.reason.c_str());
  }
}

// Потік більше не потрібен (audio_stop, кінець виклику, міст, мозок закрив сокет, вихід): від'єднати, закрити сокет,
// повідомити мозок подією audio closed, об'єкт — на видалення в головному циклі.
static void dropAudio(CallRec &r, const char *why) {
  if (!r.audio) return;
  if (r.audioOn && !r.ended && r.mediaActive && r.call) {
    try {
      AudioMedia am = r.call->getAudioMedia(-1);
      am.stopTransmit(*r.audio);
      r.audio->stopTransmit(am);
    } catch (Error &) {
    }
  }
  unsigned long long played = 0, queued = 0, droppedOut = 0;
  r.audio->shut(played, queued, droppedOut);
  r.audio->detach();
  logf("call %d: audio stream closed (%s, played %.1f s, dropped frames %llu)", r.eid, why,
       (double)played / (double)r.audio->rate(), droppedOut);
  g_deadAudios.push_back({r.audio, Clock::now()});
  r.audio = nullptr;
  r.audioOn = false;
  if (!r.silent)
    Ev("audio").call(r.eid).str("state", "closed").str("reason", why).num("played", (long long)played)
        .num("queued", (long long)queued).num("dropped_frames", (long long)droppedOut).emit();
}

static void linkBridge(CallRec &a) {
  if (!a.bridgePeer || a.ended || !a.mediaActive) return;
  CallRec *b = findRec(a.bridgePeer);
  if (!b || b->ended || !b->mediaActive || !a.call || !b->call) return;
  try {
    AudioMedia ma = a.call->getAudioMedia(-1);
    AudioMedia mb = b->call->getAudioMedia(-1);
    ma.startTransmit(mb);
    mb.startTransmit(ma);
  } catch (Error &e) {
    logf("bridge %d<->%d failed: %s", a.eid, b->eid, e.reason.c_str());
  }
}

static void unlinkBridge(CallRec &a) {
  if (!a.bridgePeer) return;
  CallRec *b = findRec(a.bridgePeer);
  if (b) {
    if (!a.ended && !b->ended && a.mediaActive && b->mediaActive && a.call && b->call) {
      try {
        AudioMedia ma = a.call->getAudioMedia(-1);
        AudioMedia mb = b->call->getAudioMedia(-1);
        ma.stopTransmit(mb);
        mb.stopTransmit(ma);
      } catch (Error &) {
      }
    }
    if (b->bridgePeer == a.eid) b->bridgePeer = 0;
  }
  a.bridgePeer = 0;
}

void GwCall::onCallState(OnCallStateParam &) {
  CallRec *r = findRec(eid_);
  if (!r || r->ended) return;
  CallInfo ci;
  try {
    ci = getInfo();
  } catch (Error &) {
    return;
  }
  if (ci.state == PJSIP_INV_STATE_DISCONNECTED) {
    // медіа вже знищене: лише забуваємо зв'язки, без stopTransmit
    r->mediaActive = false;
    r->ended = true;
    unlinkBridge(*r);
    dropPlayer(*r);
    dropRecorder(*r, "hangup");
    dropAudio(*r, "hangup");
    g_deadCalls.push_back(eid_);  // видалимо об'єкт у головному циклі
  }
  if (r->silent) return;
  Ev("state").call(eid_).str("state", stateName(ci.state)).num("code", (int)ci.lastStatusCode).str("reason", ci.lastReason).emit();
}

void GwCall::onCallMediaState(OnCallMediaStateParam &) {
  CallRec *r = findRec(eid_);
  if (!r || r->ended || r->silent) return;
  bool active = false;
  try {
    CallInfo ci = getInfo();
    for (const auto &m : ci.media)
      if (m.type == PJMEDIA_TYPE_AUDIO && m.status == PJSUA_CALL_MEDIA_ACTIVE) active = true;
  } catch (Error &) {
    return;
  }
  if (active != r->mediaActive) {
    r->mediaActive = active;
    if (!active) r->playerOn = r->recOn = r->audioOn = false;  // порт міг зникнути
    Ev("media").call(eid_).boolean("active", active).emit();
  }
  if (active) {
    r->playerOn = r->recOn = r->audioOn = false;  // медіа могли перестворити — під'єднуємо заново
    startPlayer(*r);
    startRecorder(*r);
    startAudio(*r);
    linkBridge(*r);
  }
}

// Рядки SDP і токени m=-рядка
static std::vector<std::string> splitLines(const std::string &s) {
  std::vector<std::string> out;
  size_t pos = 0;
  while (pos < s.size()) {
    size_t eol = s.find('\n', pos);
    if (eol == std::string::npos) eol = s.size();
    std::string l = s.substr(pos, eol - pos);
    if (!l.empty() && l.back() == '\r') l.pop_back();
    out.push_back(l);
    pos = eol + 1;
  }
  return out;
}

static std::vector<std::string> splitWs(const std::string &s) {
  std::vector<std::string> out;
  size_t i = 0;
  while (i < s.size()) {
    while (i < s.size() && s[i] == ' ') i++;
    size_t j = i;
    while (j < s.size() && s[j] != ' ') j++;
    if (j > i) out.push_back(s.substr(i, j - i));
    i = j;
  }
  return out;
}

// Відповідь на пропозицію: pjmedia бере порядок кодеків співрозмовника, тож якщо він
// пропонує PCMA (8), прибираємо з нашої відповіді PCMU (0) — лишається PCMA
void GwCall::onCallSdpCreated(OnCallSdpCreatedParam &prm) {
  if (prm.remSdp.wholeSdp.empty()) return;  // ми пропонуємо — порядок і так наш
  bool remotePcma = false;
  for (const auto &l : splitLines(prm.remSdp.wholeSdp)) {
    if (l.rfind("m=audio ", 0) != 0) continue;
    auto t = splitWs(l);
    for (size_t k = 3; k < t.size(); k++)
      if (t[k] == "8") remotePcma = true;
    break;
  }
  if (!remotePcma) return;
  std::string out;
  bool inAudio = false, changed = false;
  for (const auto &l : splitLines(prm.sdp.wholeSdp)) {
    if (l.rfind("m=", 0) == 0) {
      inAudio = l.rfind("m=audio ", 0) == 0;
      if (inAudio) {
        auto t = splitWs(l);
        std::string m;
        bool has8 = false;
        for (size_t k = 3; k < t.size(); k++)
          if (t[k] == "8") has8 = true;
        for (size_t k = 0; k < t.size(); k++) {
          if (k >= 3 && t[k] == "0" && has8) {
            changed = true;
            continue;
          }
          if (!m.empty()) m += ' ';
          m += t[k];
        }
        out += m + "\r\n";
        continue;
      }
    }
    if (inAudio && (l.rfind("a=rtpmap:0 ", 0) == 0 || l.rfind("a=fmtp:0 ", 0) == 0)) continue;
    if (!l.empty()) out += l + "\r\n";
  }
  if (changed) prm.sdp.wholeSdp = out;
}

void GwCall::onCallTransferStatus(OnCallTransferStatusParam &prm) {
  Ev("xfer").call(eid_).num("code", (int)prm.statusCode).str("reason", prm.reason).boolean("final", prm.finalNotify).emit();
  if (prm.finalNotify && prm.statusCode / 100 == 2) {
    prm.cont = false;
    try {
      CallOpParam op;
      hangup(op);
    } catch (Error &e) {
      logf("call %d: hangup after transfer failed: %s", eid_, e.reason.c_str());
    }
  }
}

// Вхідні REFER та INVITE/Replaces шлюзу не потрібні — відхиляємо
void GwCall::onCallTransferRequest(OnCallTransferRequestParam &prm) {
  logf("call %d: incoming REFER to %s rejected", eid_, maskUri(prm.dstUri).c_str());
  prm.statusCode = PJSIP_SC_DECLINE;
}

void GwCall::onCallReplaceRequest(OnCallReplaceRequestParam &prm) {
  logf("call %d: INVITE with Replaces rejected", eid_);
  prm.statusCode = PJSIP_SC_DECLINE;
}

// DTMF від співрозмовника (менеджер натискає 1 / 2): RFC 2833 (telephone-event у RTP) і SIP INFO
// (application/dtmf-relay). pjsua2 з on_dtmf_event віддає RFC 2833 в onDtmfEvent (початок, оновлення тривалості,
// кінець), а SIP INFO — залежно від версії в один із двох колбеків. Подію мозку шлемо одну на натискання: початок
// події (без IS_UPDATE) або onDtmfDigit; той самий символ тим самим методом з іншого колбека протягом
// kDtmfDupWindow — це те саме натискання. Подія: {"ev":"dtmf","call":N,"digit":"1","method":"rfc2833"|"info"}.
static const auto kDtmfDupWindow = std::chrono::milliseconds(300);

static const char *dtmfMethodName(int m) {
  switch (m) {
    case PJSUA_DTMF_METHOD_RFC2833: return "rfc2833";
    case PJSUA_DTMF_METHOD_SIP_INFO: return "info";
  }
  return "other";
}

static void emitDtmf(int eid, const std::string &digit, int method, int src) {
  CallRec *r = findRec(eid);
  if (!r || r->ended || r->silent || digit.empty()) return;
  auto now = Clock::now();
  if (r->dtmfSrc != 0 && r->dtmfSrc != src && r->dtmfDigit == digit && r->dtmfMethod == method &&
      now - r->dtmfAt < kDtmfDupWindow)
    return;
  r->dtmfDigit = digit;
  r->dtmfMethod = method;
  r->dtmfSrc = src;
  r->dtmfAt = now;
  // Саму цифру в лог не пишемо: клієнт міг би набрати щось особисте
  logf("call %d: dtmf via %s (%s)", eid, dtmfMethodName(method), src == 1 ? "digit" : "event");
  Ev("dtmf").call(eid).str("digit", digit).str("method", dtmfMethodName(method)).emit();
}

void GwCall::onDtmfDigit(OnDtmfDigitParam &prm) { emitDtmf(eid_, prm.digit, (int)prm.method, 1); }

void GwCall::onDtmfEvent(OnDtmfEventParam &prm) {
  if (prm.flags & PJMEDIA_STREAM_DTMF_IS_UPDATE) return;  // те саме натискання: лише нова тривалість
  emitDtmf(eid_, prm.digit, (int)prm.method, 2);
}

class GwAccount : public Account {
 public:
  void onRegState(OnRegStateParam &prm) override {
    bool active = false;
    try {
      active = getInfo().regIsActive;
    } catch (Error &) {
    }
    g_regActive = active;
    g_regEvent = true;
    // Звідки відповів реєстратор, звідти Binotel і дзвонить (і лише ці пакети пропускає NAT роутера)
    if (prm.code / 100 == 2 && !prm.rdata.srcAddress.empty()) trustAdd(hostOf(prm.rdata.srcAddress), "registrar reply");
    Ev("reg").num("code", (int)prm.code).str("reason", prm.reason).boolean("active", active).num("expires", prm.expiration).emit();
  }

  void onIncomingCall(OnIncomingCallParam &prm) override {
    int eid = g_nextEid++;
    GwCall *c = new GwCall(*this, eid, prm.callId);
    CallRec &r = g_calls[eid];
    r.eid = eid;
    r.call = c;
    const std::string src = prm.rdata.srcAddress;
    if (g_realMode && !g_trusted.count(hostOf(src))) {
      // Не від АТС (сканер SIP, пристрій у локальній мережі): 403 ще до мозку, ім'я/номер не розбираємо
      r.silent = true;
      logf("call %d: INVITE from untrusted %s rejected (403)", eid, src.c_str());
      g_rejectQ.push_back(eid);  // 403 — у головному циклі, не з колбека pjsua
      Ev("untrusted").str("src", src).str("method", "INVITE").emit();
      return;
    }
    CallInfo ci;
    try {
      ci = c->getInfo();
    } catch (Error &) {
    }
    // From/To беремо з сирого INVITE: CallInfo друкує їх без порту
    const std::string &msg = prm.rdata.wholeMsg;
    std::string fromHdr = findHeader(msg, "From");
    if (fromHdr.empty()) fromHdr = findHeader(msg, "f");
    if (fromHdr.empty()) fromHdr = ci.remoteUri;
    std::string toHdr = findHeader(msg, "To");
    if (toHdr.empty()) toHdr = findHeader(msg, "t");
    if (toHdr.empty()) toHdr = ci.localUri;
    std::string name, from, toName, to;
    parseNameAddr(fromHdr, name, from);
    parseNameAddr(toHdr, toName, to);
    std::string gcid = findHeader(msg, "X-BINOTEL-GCID");
    std::string setCid = findHeader(msg, "X-BINOTEL-SET-CALLER-ID");
    const std::string number = uriUser(from);
    logf("call %d: incoming from %s gcid=%s src=%s", eid, maskTail(number).c_str(), gcid.empty() ? "-" : gcid.c_str(), src.c_str());
    Ev("incoming")
        .call(eid)
        .str("from", from)
        .str("number", number)
        .str("name", name)
        .strOrNull("gcid", gcid)
        .str("to", to)
        .strOrNull("set_caller_id", setCid)
        .str("src", src)
        .emit();
  }
};

// ---------- команди ----------

static CallRec *liveRec(const JObj &o, const char *key, const std::string &cmd, int *eidOut = nullptr) {
  long long id = 0;
  if (!getInt(o, key, id) || id <= 0 || id > 0x7fffffff) {
    emitError(cmd, 0, "", std::string("missing or bad '") + key + "'");
    return nullptr;
  }
  if (eidOut) *eidOut = (int)id;
  CallRec *r = findRec((int)id);
  if (!r) {
    emitError(cmd, (int)id, "", "unknown call");
    return nullptr;
  }
  if (r->ended || !r->call) {
    emitError(cmd, (int)id, "", "call ended");
    return nullptr;
  }
  return r;
}

static bool needAccount(const std::string &cmd, const std::string &ref = "") {
  if (g_acc) return true;
  emitError(cmd, 0, ref, "account not configured (send register or local first)");
  return false;
}

static void cmdRegister(const JObj &o) {
  if (g_acc) return emitError("register", 0, "", "account already configured");
  std::string server, user, password;
  if (!getStr(o, "server", server) || server.empty() || !getStr(o, "user", user) || user.empty() ||
      !getStr(o, "password", password))
    return emitError("register", 0, "", "need server, user, password");
  long long expires = 120;
  if (has(o, "expires") && (!getInt(o, "expires", expires) || expires < 30 || expires > 86400))
    return emitError("register", 0, "", "bad expires");
  std::string trust;
  if (has(o, "trust") && !getStr(o, "trust", trust)) return emitError("register", 0, "", "bad trust (comma-separated IPs)");
  g_trusted.clear();
  trustResolve(hostOf(server));
  for (size_t i = 0; i < trust.size();) {
    size_t j = trust.find_first_of(", ;", i);
    if (j == std::string::npos) j = trust.size();
    std::string ip = trim(trust.substr(i, j - i));
    if (!ip.empty()) trustAdd(hostOf(ip), "trust");
    i = j + 1;
  }
  try {
    TransportConfig tc;
    tc.port = 0;  // випадковий локальний порт
    TransportId tid = g_ep->transportCreate(PJSIP_TRANSPORT_UDP, tc);

    AccountConfig ac;
    ac.idUri = "sip:" + user + "@" + server;
    ac.regConfig.registrarUri = "sip:" + server + ";transport=udp";
    ac.regConfig.timeoutSec = (unsigned)expires;
    ac.regConfig.retryIntervalSec = 30;
    ac.sipConfig.authCreds.push_back(AuthCredInfo("digest", "*", user, 0, password));
    ac.sipConfig.proxies.push_back("sip:" + server + ";transport=udp;lr");
    ac.sipConfig.transportId = tid;
    ac.natConfig.contactRewriteUse = PJ_TRUE;
    ac.natConfig.viaRewriteUse = PJ_TRUE;
    ac.natConfig.sipOutboundUse = PJ_TRUE;
    std::fill(password.begin(), password.end(), '\0');

    GwAccount *acc = new GwAccount();
    try {
      acc->create(ac, true);
    } catch (Error &) {
      delete acc;
      throw;
    }
    g_acc = acc;
    g_realMode = true;
    logf("account sip:%s@%s created, registering (expires %lld)", user.c_str(), server.c_str(), expires);
  } catch (Error &e) {
    std::fill(password.begin(), password.end(), '\0');
    emitError("register", 0, "", e.reason.empty() ? e.info() : e.reason);
  }
}

static void cmdLocal(const JObj &o) {
  if (g_acc) return emitError("local", 0, "", "account already configured");
  std::string bind = "127.0.0.1", user = "gw";
  long long port = 5092;
  getStr(o, "bind", bind);
  getStr(o, "user", user);
  if (has(o, "port") && (!getInt(o, "port", port) || port <= 0 || port > 65535))
    return emitError("local", 0, "", "bad port");
  try {
    TransportConfig tc;
    tc.port = (unsigned)port;
    tc.boundAddress = bind;
    tc.publicAddress = bind;
    TransportId tid = g_ep->transportCreate(PJSIP_TRANSPORT_UDP, tc);

    AccountConfig ac;
    ac.idUri = "sip:" + user + "@" + bind + ":" + std::to_string(port);
    ac.sipConfig.transportId = tid;
    ac.mediaConfig.transportConfig.boundAddress = bind;
    ac.mediaConfig.transportConfig.publicAddress = bind;
    GwAccount *acc = new GwAccount();
    try {
      acc->create(ac, true);
    } catch (Error &) {
      delete acc;
      throw;
    }
    g_acc = acc;
    g_realMode = false;
    logf("local account %s (no registrar)", ac.idUri.c_str());
    Ev("reg").num("code", 200).str("reason", "local").boolean("active", true).boolean("local", true).emit();
  } catch (Error &e) {
    emitError("local", 0, "", e.reason.empty() ? e.info() : e.reason);
  }
}

static void cmdAnswer(const JObj &o) {
  int eid = 0;
  CallRec *r = liveRec(o, "call", "answer", &eid);
  if (!r) return;
  long long code = 200;
  if (has(o, "code") && (!getInt(o, "code", code) || code < 100 || code > 699))
    return emitError("answer", eid, "", "bad code");
  try {
    CallOpParam op;
    op.statusCode = (pjsip_status_code)code;
    r->call->answer(op);
  } catch (Error &e) {
    emitError("answer", eid, "", e.reason.empty() ? e.info() : e.reason);
  }
}

static void cmdHangup(const JObj &o) {
  int eid = 0;
  CallRec *r = liveRec(o, "call", "hangup", &eid);
  if (!r) return;
  long long code = 0;
  if (has(o, "code") && (!getInt(o, "code", code) || (code != 0 && (code < 300 || code > 699))))
    return emitError("hangup", eid, "", "bad code");
  try {
    CallOpParam op;
    if (code) op.statusCode = (pjsip_status_code)code;
    r->call->hangup(op);
  } catch (Error &e) {
    emitError("hangup", eid, "", e.reason.empty() ? e.info() : e.reason);
  }
}

static void cmdPlay(const JObj &o) {
  int eid = 0;
  CallRec *r = liveRec(o, "call", "play", &eid);
  if (!r) return;
  std::string file, tag;
  if (!getStr(o, "file", file) || file.empty()) return emitError("play", eid, "", "need file");
  getStr(o, "tag", tag);
  bool loop = getBool(o, "loop", false);
  if (access(file.c_str(), R_OK) != 0) return emitError("play", eid, "", "file not readable: " + file);
  dropPlayer(*r);
  GwPlayer *p = new GwPlayer(eid, tag, loop);
  try {
    p->createPlayer(file, loop ? 0 : PJMEDIA_FILE_NO_LOOP);
  } catch (Error &e) {
    delete p;
    return emitError("play", eid, "", e.reason.empty() ? e.info() : e.reason);
  }
  r->player = p;
  r->playerOn = false;
  startPlayer(*r);  // якщо медіа ще немає — стартує в onCallMediaState
}

static void cmdStop(const JObj &o) {
  CallRec *r = liveRec(o, "call", "stop");
  if (r) dropPlayer(*r);
}

// Запис голосу співрозмовника у WAV (PCM 16 біт, моно, 8 кГц — частота мосту). Файл новий: наявний не
// перезаписуємо; теку створює мозок. Права — 0600 (umask 077 рушія).
static void cmdRecord(const JObj &o) {
  int eid = 0;
  CallRec *r = liveRec(o, "call", "record", &eid);
  if (!r) return;
  std::string file;
  if (!getStr(o, "file", file) || file.empty()) return emitError("record", eid, "", "need file");
  if (file[0] != '/' || file.size() < 5 || !ieq(file.substr(file.size() - 4), ".wav"))
    return emitError("record", eid, "", "file must be an absolute path to .wav");
  if (r->rec) return emitError("record", eid, "", "already recording");
  if (access(file.c_str(), F_OK) == 0) return emitError("record", eid, "", "file exists: " + file);
  AudioMediaRecorder *rec = new AudioMediaRecorder();
  try {
    rec->createRecorder(file);
  } catch (Error &e) {
    delete rec;
    unlink(file.c_str());  // pjmedia міг устигнути створити порожній файл
    return emitError("record", eid, "", e.reason.empty() ? e.info() : e.reason);
  }
  r->rec = rec;
  r->recOn = false;
  r->recFile = file;
  std::string why;
  if (r->mediaActive && !startRecorder(*r, &why)) {
    // Звук до запису не йде: без помилки мозок «писав» би тишу до voicemailMaxSec і вважав це повідомленням.
    // Рекордер у міст не під'єднаний — прибираємо одразу, порожній файл видаляємо.
    r->rec = nullptr;
    r->recFile.clear();
    delete rec;
    unlink(file.c_str());
    return emitError("record", eid, "", "recorder start failed: " + why);
  }
  logf("call %d: recording", eid);  // шлях не друкуємо: у ньому останні цифри номера
}

static void cmdRecordStop(const JObj &o) {
  int eid = 0;
  CallRec *r = liveRec(o, "call", "record_stop", &eid);
  if (!r) return;
  if (!r->rec) return emitError("record_stop", eid, "", "not recording");
  dropRecorder(*r, "stop");
}

// Потік звуку виклику до мозку: {"cmd":"audio_start","call":N,"sock":"/abs/path.sock","token":"…","rate":8000}.
// Сокет слухає мозок (тека 0700); рушій під'єднується, шле рядок привітання і далі кадри (див. GwAudio). rate — частота
// порту (8000, 16000, 24000 або 48000): міст сам перетворює частоту, мозку не треба переводити. Один потік на виклик.
static void cmdAudioStart(const JObj &o) {
  int eid = 0;
  CallRec *r = liveRec(o, "call", "audio_start", &eid);
  if (!r) return;
  if (r->audio) return emitError("audio_start", eid, "", "audio already started");
  std::string sock, token;
  if (!getStr(o, "sock", sock) || sock.empty() || sock[0] != '/')
    return emitError("audio_start", eid, "", "sock must be an absolute path");
  struct sockaddr_un sa;
  if (sock.size() >= sizeof sa.sun_path) return emitError("audio_start", eid, "", "sock path too long");
  getStr(o, "token", token);
  if (token.size() > 128) return emitError("audio_start", eid, "", "bad token");
  for (char c : token)
    if (!isalnum((unsigned char)c) && c != '-' && c != '_') return emitError("audio_start", eid, "", "bad token");
  long long rate = 8000;
  if (has(o, "rate") && (!getInt(o, "rate", rate) || (rate != 8000 && rate != 16000 && rate != 24000 && rate != 48000)))
    return emitError("audio_start", eid, "", "bad rate (8000, 16000, 24000, 48000)");
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return emitError("audio_start", eid, "", std::string("socket: ") + strerror(errno));
  fcntl(fd, F_SETFD, FD_CLOEXEC);
#ifdef SO_NOSIGPIPE
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
  memset(&sa, 0, sizeof sa);
  sa.sun_family = AF_UNIX;
  memcpy(sa.sun_path, sock.c_str(), sock.size());
  if (connect(fd, (struct sockaddr *)&sa, sizeof sa) != 0) {
    std::string why = strerror(errno);
    ::close(fd);
    return emitError("audio_start", eid, "", "connect: " + why);
  }
  fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
  GwAudio *a = new GwAudio(eid, fd, (unsigned)rate);  // сокет тепер належить порту
  try {
    MediaFormatAudio fmt;
    fmt.init(PJMEDIA_FORMAT_PCM, (unsigned)rate, 1, 20000, 16);
    a->createPort("ai" + std::to_string(eid), fmt);
  } catch (Error &e) {
    delete a;
    return emitError("audio_start", eid, "", e.reason.empty() ? e.info() : e.reason);
  }
  a->hello("{\"token\":" + jsonQuote(token) + ",\"call\":" + std::to_string(eid) + ",\"rate\":" + std::to_string(rate) + "}\n");
  r->audio = a;
  r->audioOn = false;
  startAudio(*r);  // якщо медіа ще немає — під'єднаємо в onCallMediaState
  logf("call %d: audio stream started (%lld Hz)", eid, rate);  // шлях сокета і токен не друкуємо
  Ev("audio").call(eid).str("state", "started").num("rate", rate).emit();
}

static void cmdAudioStop(const JObj &o) {
  int eid = 0;
  CallRec *r = liveRec(o, "call", "audio_stop", &eid);
  if (!r) return;
  if (!r->audio) return emitError("audio_stop", eid, "", "no audio stream");
  dropAudio(*r, "stop");
}

// Головний цикл: що прочитати з сокетів мозку і що дописати; мозок закрив сокет або помилка — потік закриваємо
static void processAudio(const fd_set &rf, const fd_set &wf) {
  for (auto &kv : g_calls) {
    CallRec &r = kv.second;
    if (!r.audio) continue;
    int fd = r.audio->fd();
    bool alive = fd >= 0 && !r.audio->broken();
    if (alive && FD_ISSET(fd, &rf)) alive = r.audio->pump();
    else if (alive && FD_ISSET(fd, &wf)) r.audio->flush();
    if (alive && r.audio->broken()) alive = false;
    if (!alive) dropAudio(r, "peer_closed");
  }
}

static void cmdDial(const JObj &o) {
  std::string ref, uri;
  getStr(o, "ref", ref);
  if (!getStr(o, "uri", uri) || uri.empty()) return emitError("dial", 0, ref, "need uri");
  if (!needAccount("dial", ref)) return;
  int eid = g_nextEid++;
  GwCall *c = new GwCall(*g_acc, eid);
  CallRec &r = g_calls[eid];
  r.eid = eid;
  r.call = c;
  r.outgoing = true;
  r.ref = ref;
  // Події, що з'являться всередині makeCall, віддамо вже після 'dialing'
  g_holdEid = eid;
  g_held.clear();
  bool ok = true;
  std::string why;
  try {
    CallOpParam prm(true);
    prm.opt.audioCount = 1;
    prm.opt.videoCount = 0;
    c->makeCall(uri, prm);
  } catch (Error &e) {
    ok = false;
    why = e.reason.empty() ? e.info() : e.reason;
  }
  g_holdEid = 0;
  std::vector<std::string> held;
  held.swap(g_held);
  if (!ok) {
    CallRec *rr = findRec(eid);
    if (rr && !rr->ended) {
      rr->ended = true;
      if (c->getId() == PJSUA_INVALID_ID) {
        rr->call = nullptr;
        delete c;
        g_calls.erase(eid);
      } else {
        g_deadCalls.push_back(eid);
      }
    }
    emitError("dial", 0, ref, why);
    return;
  }
  logf("call %d: dialing %s (ref %s)", eid, maskUri(uri).c_str(), ref.c_str());  // номер клієнта — лише 4 цифри
  Ev("dialing").strOrNull("ref", ref).call(eid).emit();
  std::lock_guard<std::mutex> g(g_outMu);
  for (const auto &line : held) writeAll(g_evfd, line.data(), line.size());
}

static void cmdXfer(const JObj &o) {
  int eid = 0;
  CallRec *r = liveRec(o, "call", "xfer", &eid);
  if (!r) return;
  std::string uri;
  if (!getStr(o, "uri", uri) || uri.empty()) return emitError("xfer", eid, "", "need uri");
  try {
    CallOpParam op(true);
    r->call->xfer(uri, op);
    logf("call %d: blind transfer to %s", eid, maskUri(uri).c_str());
  } catch (Error &e) {
    emitError("xfer", eid, "", e.reason.empty() ? e.info() : e.reason);
  }
}

static void cmdXferReplaces(const JObj &o) {
  int a = 0, b = 0;
  CallRec *ra = liveRec(o, "call", "xfer_replaces", &a);
  if (!ra) return;
  CallRec *rb = liveRec(o, "dest", "xfer_replaces", &b);
  if (!rb) return;
  if (a == b) return emitError("xfer_replaces", a, "", "call and dest are the same");
  try {
    CallOpParam op(true);
    // Як консоль pjsua у ручній перевірці з Binotel 2026-10-16: Refer-To лише з ?Replaces=…, без Require=replaces
    op.options = PJSUA_XFER_NO_REQUIRE_REPLACES;
    ra->call->xferReplaces(*rb->call, op);
    logf("call %d: attended transfer, replaces call %d", a, b);
  } catch (Error &e) {
    emitError("xfer_replaces", a, "", e.reason.empty() ? e.info() : e.reason);
  }
}

static void cmdBridge(const JObj &o) {
  int a = 0, b = 0;
  CallRec *ra = liveRec(o, "a", "bridge", &a);
  if (!ra) return;
  CallRec *rb = liveRec(o, "b", "bridge", &b);
  if (!rb) return;
  if (a == b) return emitError("bridge", a, "", "a and b are the same");
  dropPlayer(*ra);
  dropPlayer(*rb);
  dropAudio(*ra, "bridge");  // далі говорять люди: ШІ від'єднуємо
  dropAudio(*rb, "bridge");
  if (ra->bridgePeer && ra->bridgePeer != b) unlinkBridge(*ra);
  if (rb->bridgePeer && rb->bridgePeer != a) unlinkBridge(*rb);
  ra->bridgePeer = b;
  rb->bridgePeer = a;
  linkBridge(*ra);  // якщо медіа ще немає — з'єднаємо в onCallMediaState
  logf("bridge %d <-> %d", a, b);
}

static void handleLine(std::string &line) {
  std::string t = trim(line);
  if (t.empty()) return;
  JObj o;
  JParser p(t);
  bool parsed = p.object(o);
  std::fill(t.begin(), t.end(), '\0');
  std::fill(line.begin(), line.end(), '\0');  // у рядку register — пароль
  if (!parsed) return emitError("", 0, "", "bad json");
  std::string cmd;
  if (!getStr(o, "cmd", cmd)) return emitError("", 0, "", "missing cmd");
  logf("cmd %s", cmd.c_str());  // без вмісту: у register є пароль
  if (cmd == "register") cmdRegister(o);
  else if (cmd == "local") cmdLocal(o);
  else if (cmd == "answer") cmdAnswer(o);
  else if (cmd == "hangup") cmdHangup(o);
  else if (cmd == "play") cmdPlay(o);
  else if (cmd == "stop") cmdStop(o);
  else if (cmd == "dial") cmdDial(o);
  else if (cmd == "xfer") cmdXfer(o);
  else if (cmd == "xfer_replaces") cmdXferReplaces(o);
  else if (cmd == "bridge") cmdBridge(o);
  else if (cmd == "record") cmdRecord(o);
  else if (cmd == "record_stop") cmdRecordStop(o);
  else if (cmd == "audio_start") cmdAudioStart(o);
  else if (cmd == "audio_stop") cmdAudioStop(o);
  else if (cmd == "quit") g_quit = true;
  else emitError(cmd, 0, "", "unknown cmd");
  auto pw = o.find("password");
  if (pw != o.end()) std::fill(pw->second.s.begin(), pw->second.s.end(), '\0');
}

// ---------- головний цикл ----------

static void processEof() {
  std::vector<EofNote> q;
  {
    std::lock_guard<std::mutex> g(g_eofMu);
    q.swap(g_eofQ);
  }
  for (const auto &n : q) {
    CallRec *r = findRec(n.eid);
    if (!r || r->ended || !r->player || r->player->gen() != n.gen) continue;  // уже замінений або зупинений
    std::string tag = r->player->tag();
    dropPlayer(*r);
    Ev("play_done").call(n.eid).str("tag", tag).emit();
  }
}

static void processRejects() {
  if (g_rejectQ.empty()) return;
  std::vector<int> q;
  q.swap(g_rejectQ);
  for (int eid : q) {
    CallRec *r = findRec(eid);
    if (!r || r->ended || !r->call) continue;
    try {
      CallOpParam op;
      op.statusCode = PJSIP_SC_FORBIDDEN;
      r->call->hangup(op);
    } catch (Error &e) {
      logf("call %d: reject failed: %s", eid, e.reason.c_str());
    }
  }
}

// Довжина звуку в WAV із заголовка: data-чанк і байт/с із fmt. false — файлу немає або це не RIFF/WAVE.
static bool wavInfo(const std::string &file, long long &dataLen, long long &byteRate, long long &fileSize) {
  struct stat st;
  if (stat(file.c_str(), &st) != 0) return false;
  fileSize = (long long)st.st_size;
  FILE *f = fopen(file.c_str(), "rb");
  if (!f) return false;
  unsigned char h[512];
  size_t n = fread(h, 1, sizeof h, f);
  fclose(f);
  if (n < 12 || memcmp(h, "RIFF", 4) != 0 || memcmp(h + 8, "WAVE", 4) != 0) return false;
  auto u32 = [&](size_t at) { return (long long)h[at] | ((long long)h[at + 1] << 8) | ((long long)h[at + 2] << 16) | ((long long)h[at + 3] << 24); };
  dataLen = -1;
  byteRate = 16000;
  size_t off = 12;
  while (off + 8 <= n) {
    long long len = u32(off + 4);
    if (memcmp(h + off, "fmt ", 4) == 0 && off + 20 <= n) byteRate = u32(off + 16);
    if (memcmp(h + off, "data", 4) == 0) {
      dataLen = len;
      break;
    }
    off += 8 + (size_t)len + (size_t)(len & 1);
  }
  if (byteRate <= 0) byteRate = 16000;
  return dataLen >= 0;
}

// record_done: заголовок WAV уже з довжиною (порт закрито) або минуло kRecFinalWait. force — після libDestroy.
static void processRecs(bool force = false) {
  if (g_closingRecs.empty()) return;
  auto now = Clock::now();
  std::vector<ClosingRec> keep;
  for (const auto &c : g_closingRecs) {
    long long len = -1, rate = 16000, size = 0;
    bool ok = wavInfo(c.file, len, rate, size);
    bool finalHdr = ok && len > 0;
    if (!finalHdr && !force && now - c.at < kRecFinalWait) {
      keep.push_back(c);
      continue;
    }
    double sec = 0;
    if (finalHdr) sec = (double)len / (double)rate;
    else if (size > 44) sec = (double)(size - 44) / (double)rate;  // заголовок не оновився — оцінка за розміром
    Ev e("record_done");
    e.call(c.eid).str("file", c.file).real("sec", sec).str("reason", c.why).boolean("final", finalHdr);
    if (!ok && size == 0) e.boolean("missing", true);
    e.emit();
    logf("call %d: recording closed (%s, %.1f s%s)", c.eid, c.why.c_str(), sec, finalHdr ? "" : ", header not final");
  }
  g_closingRecs.swap(keep);
}

// Відкладене видалення програвачів і дзвінків (ніколи не з їхніх власних колбеків)
static void reap(bool all = false) {
  for (auto &d : g_deadRecs) {
    delete d.rec;  // порт знімається з мосту асинхронно; WAV закриє потік мосту
    g_closingRecs.push_back({d.eid, d.file, d.why, Clock::now()});
  }
  g_deadRecs.clear();
  if (!g_deadAudios.empty()) {
    auto now = Clock::now();
    std::vector<DeadAudio> keep;
    for (const auto &d : g_deadAudios) {
      if (all || now - d.at >= kPlayerLinger) delete d.a;
      else keep.push_back(d);
    }
    g_deadAudios.swap(keep);
  }
  if (!g_deadPlayers.empty()) {
    auto now = Clock::now();
    std::vector<DeadPlayer> keep;
    for (const auto &d : g_deadPlayers) {
      if (all || now - d.at >= kPlayerLinger) delete d.p;
      else keep.push_back(d);
    }
    g_deadPlayers.swap(keep);
  }
  for (int eid : g_deadCalls) {
    auto it = g_calls.find(eid);
    if (it == g_calls.end()) continue;
    GwCall *c = it->second.call;
    if (c) {
      int pjid = c->getId();
      void *ud = (pjid >= 0) ? pjsua_call_get_user_data(pjid) : nullptr;
      // слот pjsua вже зайнятий іншим дзвінком — деструктор зачепив би його, тож краще не видаляти
      if (ud == nullptr || ud == static_cast<Call *>(c)) delete c;
      else logf("call %d: pjsua slot %d reused, object leaked", eid, pjid);
    }
    g_calls.erase(it);
  }
  g_deadCalls.clear();
}

static void pump(int ms, const std::function<bool()> &done) {
  auto until = Clock::now() + std::chrono::milliseconds(ms);
  while (Clock::now() < until && !done()) {
    g_ep->libHandleEvents(20);
    processRejects();
    processEof();
    reap();
    processRecs();
  }
}

static bool allEnded() {
  for (const auto &kv : g_calls)
    if (!kv.second.ended) return false;
  return true;
}

static void shutdownAll() {
  logf("shutting down");
  if (!allEnded()) {
    try {
      g_ep->hangupAllCalls();
    } catch (Error &) {
    }
    pump(3000, allEnded);
  }
  if (g_acc && g_realMode && g_regActive) {
    g_regEvent = false;
    try {
      g_acc->setRegistration(false);
      pump(3000, [] { return g_regEvent; });
    } catch (Error &e) {
      logf("unregister failed: %s", e.reason.c_str());
    }
  }
  processEof();
  reap();
  for (auto &kv : g_calls) {
    dropPlayer(kv.second);
    dropRecorder(kv.second, "shutdown");
    dropAudio(kv.second, "shutdown");
    delete kv.second.call;  // деструктор сам покладе, якщо ще живий
    kv.second.call = nullptr;
  }
  g_calls.clear();
  // Порти звуку до мозку вже зняті з моста (detach), але міст прибирає їх асинхронно — дати йому кілька тактів
  if (!g_deadAudios.empty()) pump(200, [] { return false; });
  reap(true);
  delete g_acc;
  g_acc = nullptr;
  try {
    g_ep->libDestroy();
  } catch (Error &e) {
    logf("libDestroy: %s", e.reason.c_str());
  }
  processRecs(true);  // міст знищено — усі WAV закриті
}

// Журнал pjsip з текстами SIP (рівень 4+): значення Authorization/Proxy-Authorization (digest response —
// матеріал для підбору пароля лінії офлайн) і nonce у WWW-/Proxy-Authenticate замінюємо на <…>.
static bool startsWithI(const std::string &s, size_t pos, const char *p) {
  size_t n = strlen(p);
  if (s.size() - pos < n) return false;
  for (size_t i = 0; i < n; i++)
    if (tolower((unsigned char)s[pos + i]) != tolower((unsigned char)p[i])) return false;
  return true;
}

static std::string redactAuth(const std::string &in) {
  if (in.find("uthori") == std::string::npos && in.find("uthenticate") == std::string::npos) return in;
  std::string out;
  out.reserve(in.size());
  size_t pos = 0;
  while (pos < in.size()) {
    size_t eol = in.find('\n', pos);
    size_t end = eol == std::string::npos ? in.size() : eol + 1;
    std::string line = in.substr(pos, end - pos);
    if (startsWithI(line, 0, "Authorization:") || startsWithI(line, 0, "Proxy-Authorization:")) {
      size_t colon = line.find(':');
      bool cr = line.size() >= 2 && line[line.size() - 2] == '\r';
      bool nl = !line.empty() && line.back() == '\n';
      line = line.substr(0, colon + 1) + " <…>" + (cr ? "\r" : "") + (nl ? "\n" : "");
    } else if (startsWithI(line, 0, "WWW-Authenticate:") || startsWithI(line, 0, "Proxy-Authenticate:")) {
      for (const char *k : {"nonce=", "opaque="}) {
        size_t at = 0;
        while ((at = line.find(k, at)) != std::string::npos) {
          size_t v = at + strlen(k);
          size_t ve = v;
          if (ve < line.size() && line[ve] == '"') {
            size_t q = line.find('"', ve + 1);
            ve = q == std::string::npos ? line.size() : q + 1;
          } else {
            while (ve < line.size() && line[ve] != ',' && line[ve] != '\r' && line[ve] != '\n') ve++;
          }
          line.replace(v, ve - v, "\"<…>\"");
          at = v + 1;
        }
      }
    }
    out += line;
    pos = end;
  }
  return out;
}

class StderrLog : public LogWriter {
 public:
  void write(const LogEntry &e) override {
    std::string m = redactAuth(e.msg);
    if (m.empty() || m.back() != '\n') m += '\n';
    writeAll(2, m.data(), m.size());
  }
};

static void onSignal(int sig) { g_signal = sig; }

int main() {
  signal(SIGPIPE, SIG_IGN);
  umask(077);  // записи голосової пошти (голос клієнта) — лише власнику
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = onSignal;
  sigaction(SIGINT, &sa, nullptr);
  sigaction(SIGTERM, &sa, nullptr);

  // stdout — лише для подій; будь-який сторонній printf піде в stderr
  g_evfd = dup(1);
  if (g_evfd < 0) return 2;
  fcntl(g_evfd, F_SETFD, FD_CLOEXEC);
  dup2(2, 1);

  int lvl = 3;
  if (const char *e = getenv("SIP_ENGINE_LOG_LEVEL")) lvl = std::max(0, std::min(6, atoi(e)));

  pj_log_set_level(lvl);  // ще до libCreate: інакше pjlib стартує з рівнем 5

  Endpoint ep;
  g_ep = &ep;
  try {
    ep.libCreate();
    EpConfig cfg;
    cfg.uaConfig.threadCnt = 0;
    cfg.uaConfig.mainThreadOnly = true;
    cfg.uaConfig.maxCalls = 16;
    cfg.uaConfig.userAgent = "Runferry-VoiceGateway/0.1";
    cfg.medConfig.clockRate = 8000;
    cfg.medConfig.sndClockRate = 8000;
    cfg.medConfig.noVad = true;
    cfg.medConfig.ecTailLen = 0;
    cfg.logConfig.level = (unsigned)lvl;
    cfg.logConfig.consoleLevel = (unsigned)lvl;
    cfg.logConfig.msgLogging = PJ_TRUE;
    cfg.logConfig.writer = new StderrLog();  // знищує Endpoint
    ep.libInit(cfg);
    ep.audDevManager().setNullDev();
    for (const CodecInfo &ci : ep.codecEnum2()) {
      pj_uint8_t pr = 0;
      if (ci.codecId.rfind("PCMA/8000", 0) == 0) pr = 255;
      else if (ci.codecId.rfind("PCMU/8000", 0) == 0) pr = 254;
      ep.codecSetPriority(ci.codecId, pr);
    }
    ep.libStart();
  } catch (Error &e) {
    logf("init failed: %s", e.info().c_str());
    Ev("error").null("cmd").null("call").null("ref").str("msg", "init failed: " + e.reason).emit();
    return 1;
  }
  // record — рушій уміє record/record_stop (голосова пошта); dtmf — повідомляє натискання (RFC 2833 і SIP INFO);
  // audio — уміє audio_start/audio_stop (потік звуку виклику до мозку для ШІ-співрозмовника)
  Ev("ready").boolean("record", true).boolean("dtmf", true).boolean("audio", true).emit();

  std::string inbuf;
  bool eof = false;
  while (!g_quit && !g_signal) {
    fd_set rf, wf;
    FD_ZERO(&rf);
    FD_ZERO(&wf);
    FD_SET(0, &rf);
    int maxfd = 0;
    for (auto &kv : g_calls) {  // сокети потоків звуку до мозку: прийшов звук — прокидаємось одразу
      if (!kv.second.audio) continue;
      int afd = kv.second.audio->fd();
      if (afd < 0 || afd >= FD_SETSIZE) continue;
      FD_SET(afd, &rf);
      if (kv.second.audio->wantWrite()) FD_SET(afd, &wf);
      maxfd = std::max(maxfd, afd);
    }
    struct timeval tv = {0, 10000};
    bool gotInput = false;
    int n = select(maxfd + 1, &rf, &wf, nullptr, &tv);
    if (n > 0 && FD_ISSET(0, &rf)) {
      char buf[8192];
      ssize_t k = read(0, buf, sizeof buf);
      if (k > 0) {
        inbuf.append(buf, (size_t)k);
        memset(buf, 0, (size_t)k);
        gotInput = true;
      } else if (k == 0 || (errno != EINTR && errno != EAGAIN)) {
        eof = true;
      }
    } else if (n < 0 && errno != EINTR) {
      eof = true;
    }
    size_t pos;
    while (!g_quit && (pos = inbuf.find('\n')) != std::string::npos) {
      std::string line = inbuf.substr(0, pos);
      std::fill(inbuf.begin(), inbuf.begin() + (long)pos + 1, '\0');
      inbuf.erase(0, pos + 1);
      handleLine(line);
    }
    if (inbuf.size() > 65536) {
      std::fill(inbuf.begin(), inbuf.end(), '\0');
      inbuf.clear();
      emitError("", 0, "", "line too long");
    }
    if (eof) {
      if (!g_quit && !inbuf.empty()) handleLine(inbuf);
      logf("stdin closed");
      g_quit = true;
    }
    if (n > 0 && maxfd > 0) processAudio(rf, wf);
    ep.libHandleEvents(gotInput ? 0 : 10);
    processRejects();
    processEof();
    reap();
    processRecs();
  }
  if (g_signal) logf("signal %d", (int)g_signal);
  shutdownAll();
  return 0;
}
