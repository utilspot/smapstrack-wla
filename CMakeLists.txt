cmake_minimum_required(VERSION 3.13)
project(smapstrack-wla VERSION 1.0.0 LANGUAGES C)

include(GNUInstallDirs)

find_program(NPM_EXECUTABLE npm REQUIRED)
mark_as_advanced(NPM_EXECUTABLE)

if (WIN32)
  set(NPM_PREFIX "cmd" "/c")
endif ()

find_package(LibNetQ REQUIRED)
find_package(libssh2 CONFIG REQUIRED)

option(SMAPSTRACK_INSTALL_SERVER "Install the smapstrack server" ON)
option(SMAPSTRACK_INSTALL_MODULE "Install the smapstrack module" ON)
option(SMAPSTRACK_INSTALL_ASSETS "Install smapstrack supporting assets" ON)

set(SMAPSTRACK_BASE_URL "/" CACHE STRING "URL path prefix the smapstrack module is served under (a trailing slash is appended if missing)")
set(SMAPSTRACK_ROOT_URL "${SMAPSTRACK_BASE_URL}")
if (NOT SMAPSTRACK_ROOT_URL MATCHES "/$")
  set(SMAPSTRACK_ROOT_URL "${SMAPSTRACK_ROOT_URL}/")
endif ()

set(SMAPSTRACK_ENDPOINT "" CACHE STRING "SSH target the app connects to by itself, without a connect form or credentials, as user@host[:port], host an IPv4 address or a name (port 22 when omitted; host 0.0.0.0 means the web page's own hostname); empty lets the user enter any target")
set(SMAPSTRACK_API_URL "${SMAPSTRACK_ROOT_URL}api")
set(SMAPSTRACK_ASSETS_DIR "${CMAKE_INSTALL_DATADIR}/${PROJECT_NAME}")

set(SMAPSTRACK_DATAFILES
  config.h.in
  )

file(GLOB_RECURSE SMAPSTRACK_TSXFILES
  "src/*.ts"
  "src/*.tsx"
  )

set(SMAPSTRACK_DISTFILES
  dist/index.html
  dist/manifest.json
  )

configure_file(config.h.in "${CMAKE_CURRENT_BINARY_DIR}/config.h" @ONLY)
configure_file(config.json.in "${CMAKE_CURRENT_BINARY_DIR}/config.json" @ONLY)

add_custom_command(
  COMMAND ${NPM_PREFIX} "${NPM_EXECUTABLE}" install
  COMMAND ${NPM_PREFIX} "${NPM_EXECUTABLE}" run build --config="${CMAKE_CURRENT_BINARY_DIR}/config.json"
  DEPENDS package.json "${CMAKE_CURRENT_BINARY_DIR}/config.json" ${SMAPSTRACK_TSXFILES}
  OUTPUT ${SMAPSTRACK_DISTFILES}
  WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
  )

source_group(TREE "${CMAKE_CURRENT_SOURCE_DIR}" FILES module.c ${SMAPSTRACK_DATAFILES} ${SMAPSTRACK_DISTFILES})
add_library(smapstrack_wla SHARED module.c ${SMAPSTRACK_DATAFILES} ${SMAPSTRACK_DISTFILES})
target_include_directories(smapstrack_wla PRIVATE "$<BUILD_INTERFACE:${CMAKE_CURRENT_BINARY_DIR}>")
target_link_libraries(smapstrack_wla PUBLIC LibNetQ::LibNetQ)
target_link_libraries(smapstrack_wla PRIVATE libssh2::libssh2_static)
set_property(TARGET smapstrack_wla PROPERTY POSITION_INDEPENDENT_CODE ON)
set_target_properties(smapstrack_wla PROPERTIES PREFIX "" IMPORT_PREFIX "")

source_group(TREE "${CMAKE_CURRENT_SOURCE_DIR}" FILES server.c)
add_executable(smapstrack_server server.c)
target_link_libraries(smapstrack_server PRIVATE LibNetQ::LibNetQ)

if (APPLE)
  set_target_properties(smapstrack_server PROPERTIES INSTALL_RPATH "@loader_path/../lib")
elseif (UNIX)
  set_target_properties(smapstrack_server PROPERTIES INSTALL_RPATH "$ORIGIN/../lib")
  target_link_options(smapstrack_server PRIVATE -Wl,--disable-new-dtags)
endif ()

if (SMAPSTRACK_INSTALL_SERVER)
  install(TARGETS smapstrack_server
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
    )
endif ()

if (SMAPSTRACK_INSTALL_MODULE)
  install(TARGETS smapstrack_wla
    LIBRARY DESTINATION ${CMAKE_INSTALL_BINDIR}
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
    )
endif ()

if (SMAPSTRACK_INSTALL_ASSETS)
  install(DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/dist/"
    DESTINATION "${SMAPSTRACK_ASSETS_DIR}"
    )
endif ()
