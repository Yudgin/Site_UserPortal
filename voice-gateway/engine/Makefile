# Збірка sip-engine: pjproject 2.17 з Homebrew (статичні бібліотеки), clang++, C++17, macOS arm64.
# pkg-config немає, тож прапорці переписані з $(PJ)/lib/pkgconfig/libpjproject.pc (Libs + Libs.private).

PJ   ?= /opt/homebrew/Cellar/pjproject/2.17
SSL  ?= /opt/homebrew/opt/openssl@4
T    := aarch64-apple-darwin25.6.0

CXX      := clang++
CXXFLAGS ?= -O2 -g
CXXFLAGS += -std=c++17 -Wall -Wextra -Wno-unused-parameter
CPPFLAGS += -isystem $(PJ)/include -DPJ_AUTOCONF=1 -DPJ_IS_BIG_ENDIAN=0 -DPJ_IS_LITTLE_ENDIAN=1

PJ_LIBS := -L$(PJ)/lib \
  -lpjsua2-$(T) -lpjsua-$(T) -lpjsip-ua-$(T) -lpjsip-simple-$(T) -lpjsip-$(T) \
  -lpjmedia-codec-$(T) -lpjmedia-videodev-$(T) -lpjmedia-audiodev-$(T) -lpjmedia-$(T) \
  -lpjnath-$(T) -lpjlib-util-$(T) -lpj-$(T) \
  -lsrtp-$(T) -lresample-$(T) -lgsmcodec-$(T) -lspeex-$(T) -lilbccodec-$(T) \
  -lg7221codec-$(T) -lyuv-$(T) -lwebrtc-$(T)

SYS_LIBS := -L$(SSL)/lib -lssl -lcrypto -lm -lpthread \
  -framework CoreAudio -framework CoreServices -framework AudioUnit -framework AudioToolbox \
  -framework Foundation -framework AppKit -framework AVFoundation -framework CoreGraphics \
  -framework QuartzCore -framework CoreVideo -framework CoreMedia -framework Metal \
  -framework MetalKit -framework VideoToolbox

# sip-engine-next — та сама збірка під іншим ім'ям: новий рушій можна зібрати й перевірити, поки шлюз працює
# зі старим sip-engine (його файл під живим процесом не перезаписуємо); шлюз бере його з VG_ENGINE_PATH / --engine.
sip-engine sip-engine-next: engine.cpp Makefile
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -o $@ engine.cpp $(PJ_LIBS) $(SYS_LIBS)

clean:
	rm -f sip-engine sip-engine-next
	rm -rf sip-engine.dSYM sip-engine-next.dSYM

.PHONY: clean
