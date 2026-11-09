// MagicPodsCore: https://github.com/steam3d/MagicPodsCore
// Copyright: 2020-2026 Aleksandr Maslov <https://magicpods.app> & Andrei Litvintsev <a.a.litvintsev@gmail.com>
// License: GPL-3.0

#include "SettingsService.h"

#include <stdexcept>
#include <fstream>
#include <filesystem>

#include "Logger.h"

namespace MagicPodsCore {

SettingsService::SettingsService(const std::string& filePath) : _filePath(filePath), _onSettingUpdate{} {
    LoadFromFile();
    MergeDefaults(_settings, GetDefaults());
    WriteToFile();
}

void SettingsService::LoadFromFile() {
    std::ifstream file(_filePath);
    if (!file.is_open()) {
        return;
    }

    try {
        _settings = toml::parse_file(_filePath);
    } catch (const toml::parse_error& e) {
        throw std::runtime_error("Failed to parse TOML file: " + std::string(e.what()));
    }
}

void SettingsService::WriteToFile() {
    const std::filesystem::path path(_filePath);
    const std::filesystem::path dir = path.parent_path();
    if (std::filesystem::create_directories(dir)) {
        // A newly created config directory is private: the file holds device keys.
        std::filesystem::permissions(dir, std::filesystem::perms::owner_all, std::filesystem::perm_options::replace);
    }

    std::ostringstream out;
    out << _settings;
    const std::string data = out.str();

    // Write a private temporary file beside the config, then rename it over the config.
    // mkstemp creates the file with mode 0600, so the keys are never readable by other users,
    // and the rename means a crash leaves either the old or the new file, never a truncated one.
    std::string tmpPath = _filePath + ".XXXXXX";
    const int fd = mkstemp(tmpPath.data());
    if (fd < 0) {
        throw std::runtime_error("Failed to open file for writing: " + _filePath + ": " + std::strerror(errno));
    }

    bool ok = true;
    int error = 0;
    const char* cursor = data.data();
    size_t left = data.size();
    while (left > 0) {
        const ssize_t written = write(fd, cursor, left);
        if (written < 0) {
            if (errno == EINTR)
                continue;
            ok = false;
            error = errno;
            break;
        }
        cursor += written;
        left -= static_cast<size_t>(written);
    }
    if (ok && fsync(fd) != 0) {
        ok = false;
        error = errno;
    }
    if (close(fd) != 0 && ok) {
        ok = false;
        error = errno;
    }
    if (ok && rename(tmpPath.c_str(), _filePath.c_str()) != 0) {
        ok = false;
        error = errno;
    }
    if (!ok) {
        unlink(tmpPath.c_str());
        throw std::runtime_error("Failed to write to file: " + _filePath + ": " + std::strerror(error));
    }
}

toml::table SettingsService::GetDefaults() {
    toml::table magicpods{};
    magicpods.insert_or_assign("animation", true);
    magicpods.insert_or_assign("aap_mic_agc", true);
    magicpods.insert_or_assign("aap_mic_a2dp_reset", true);
    magicpods.insert_or_assign("aap_mic_keep_alive", true);
    magicpods.insert_or_assign("logLevel", static_cast<int>(LogLevel::Info));

    toml::table defaults{};
    defaults.insert_or_assign("magicpods", std::move(magicpods));
    return defaults;
}

const toml::table& SettingsService::GetSettingsAll() {
    return _settings;
}

toml::table SettingsService::GetSettingsAllWrapped() {
    toml::table wrapped;
    wrapped.insert_or_assign("settings", _settings);
    return wrapped;
}

const toml::table& SettingsService::GetSettings(const std::string& container) {
    auto containerTable = _settings[container].as_table();
    if (!containerTable) {
        _settings.insert_or_assign(container, toml::table{});
        containerTable = _settings[container].as_table();
    }
    return *containerTable;
}

toml::node_view<toml::node> SettingsService::GetSetting(const std::string& container, const std::string& name) {
    auto containerTable = _settings[container].as_table();
    if (!containerTable) {
        return toml::node_view<toml::node>{};
    }
    return (*containerTable)[name];
}

void SettingsService::SaveSettings(const toml::table& table) {
    auto settingsRoot = table["settings"].as_table();
    if (!settingsRoot) {
        throw std::invalid_argument("Table must contain 'settings' root key");
    }

    for (const auto& [containerName, containerData] : *settingsRoot) {
        if (auto incomingContainer = containerData.as_table()) {
            auto existingContainer = _settings[containerName].as_table();
            if (!existingContainer) {
                _settings.insert_or_assign(containerName, toml::table{});
                existingContainer = _settings[containerName].as_table();
            }

            for (const auto& [key, value] : *incomingContainer) {
                existingContainer->insert_or_assign(key, value);
            }
        }
    }

    WriteToFile();

    for (const auto& [containerName, containerData] : *settingsRoot) {
        if (auto incomingContainer = containerData.as_table()) {
            auto existingContainer = _settings[containerName].as_table();
            for (const auto& [key, value] : *incomingContainer) {
                auto savedValue = (*existingContainer)[key];
                _onSettingUpdate.FireEvent(UpdatedSettingNotification{containerName, key, savedValue});
            }
        }
    }
}

void SettingsService::SaveSetting(const std::string& container, const std::string& name, const toml::node& value) {
    auto containerTable = _settings[container].as_table();
    if (!containerTable) {
        _settings.insert_or_assign(container, toml::table{});
        containerTable = _settings[container].as_table();
    }
    containerTable->insert_or_assign(name, value);
    WriteToFile();

    auto savedValue = (*containerTable)[name];
    _onSettingUpdate.FireEvent(UpdatedSettingNotification{container, name, savedValue});
}

void SettingsService::SaveSetting(const std::string& container, const std::string& name, const toml::node_view<const toml::node>& value) {
    if (value) {
        auto containerTable = _settings[container].as_table();
        if (!containerTable) {
            _settings.insert_or_assign(container, toml::table{});
            containerTable = _settings[container].as_table();
        }
        containerTable->insert_or_assign(name, *value.node());
        WriteToFile();

        auto savedValue = (*containerTable)[name];
        _onSettingUpdate.FireEvent(UpdatedSettingNotification{container, name, savedValue});
    }
}

std::string SettingsService::GetConfigPath(const std::string &fileName) {
    if (const char* xdg = std::getenv("XDG_CONFIG_HOME"))
        return std::string(xdg) + "/magicpods/" + fileName;

    if (const char* home = std::getenv("HOME"))
        return std::string(home) + "/.config/magicpods/" + fileName;

    throw std::runtime_error("Cannot determine config path");    
}
}
