// MagicPodsCore: https://github.com/steam3d/MagicPodsCore
// Copyright: 2020-2026 Aleksandr Maslov <https://magicpods.app> & Andrei Litvintsev <a.a.litvintsev@gmail.com>
// License: GPL-3.0

#include "SettingsService.h"

#include <stdexcept>
#include <fstream>
#include <filesystem>
#include <sstream>
#include <system_error>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cctype>
#include <chrono>
#include <vector>

#include <fcntl.h>
#include <sys/types.h>
#include <unistd.h>

#include "Logger.h"

namespace MagicPodsCore {

SettingsService::SettingsService(const std::string& filePath) : _filePath(filePath), _onSettingUpdate{} {
    std::lock_guard<std::recursive_mutex> lock(_mutex);
    RemoveStaleTempFiles();
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
    std::filesystem::path target(_filePath);
    // A symlinked config keeps working: write to the file it points at, not over the link.
    if (std::filesystem::is_symlink(target))
        target = std::filesystem::weakly_canonical(target);

    const std::filesystem::path dir = target.parent_path();
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
    std::string tmpPath = target.string() + ".XXXXXX";
    const int fd = mkstemp(tmpPath.data());
    if (fd < 0) {
        const int error = errno;
        throw std::runtime_error("Failed to open file for writing: " + _filePath + ": " + std::generic_category().message(error));
    }

    int error = 0;
    const char* cursor = data.data();
    size_t left = data.size();
    while (left > 0) {
        const ssize_t written = write(fd, cursor, left);
        if (written < 0) {
            if (errno == EINTR)
                continue;
            error = errno;
            break;
        }
        if (written == 0) {
            error = EIO;
            break;
        }
        cursor += written;
        left -= static_cast<size_t>(written);
    }
    if (error == 0 && fsync(fd) != 0)
        error = errno;
    if (close(fd) != 0 && error == 0)
        error = errno;
    if (error == 0 && std::rename(tmpPath.c_str(), target.c_str()) != 0)
        error = errno;
    if (error != 0) {
        unlink(tmpPath.c_str());
        throw std::runtime_error("Failed to write to file: " + _filePath + ": " + std::generic_category().message(error));
    }

    // Make the rename itself durable; best effort.
    const int dirFd = open(dir.c_str(), O_RDONLY | O_DIRECTORY);
    if (dirFd >= 0) {
        fsync(dirFd);
        close(dirFd);
    }
}

// A crash between mkstemp and rename leaves "<config>.XXXXXX" behind. Remove such files
// once they are clearly abandoned (older than 10 minutes), so a second copy starting
// up never deletes the file the running one is writing right now.
void SettingsService::RemoveStaleTempFiles() {
    std::error_code ec;
    std::filesystem::path target(_filePath);
    if (std::filesystem::is_symlink(target, ec))
        target = std::filesystem::weakly_canonical(target, ec);
    const std::filesystem::path dir = target.parent_path();
    const std::string prefix = target.filename().string() + ".";
    const auto cutoff = std::filesystem::file_time_type::clock::now() - std::chrono::minutes(10);
    for (std::filesystem::directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec)) {
        const std::string name = it->path().filename().string();
        if (name.size() != prefix.size() + 6 || name.compare(0, prefix.size(), prefix) != 0)
            continue;
        // mkstemp suffixes are 6 letters/digits; ask for a digit or a capital too, so a
        // hand-made "config.toml.backup" or ".broken" is never touched.
        bool alnum = true, mixed = false;
        for (const char c : name.substr(prefix.size())) {
            if (!std::isalnum(static_cast<unsigned char>(c)))
                alnum = false;
            if (std::isdigit(static_cast<unsigned char>(c)) || std::isupper(static_cast<unsigned char>(c)))
                mixed = true;
        }
        if (!alnum || !mixed)
            continue;
        std::error_code entryEc;
        if (it->is_symlink(entryEc) || !it->is_regular_file(entryEc))
            continue;
        const auto modified = std::filesystem::last_write_time(it->path(), entryEc);
        if (entryEc || modified > cutoff)
            continue;
        if (std::filesystem::remove(it->path(), entryEc))
            Logger::Info("Removed leftover settings file %s", name.c_str());
    }
}

void SettingsService::Fire(const std::vector<UpdatedSettingNotification>& notifications) {
    for (const auto& notification : notifications)
        _onSettingUpdate.FireEvent(notification);
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

toml::table SettingsService::GetSettingsAll() {
    std::lock_guard<std::recursive_mutex> lock(_mutex);
    return _settings;
}

toml::table SettingsService::GetSettingsAllWrapped() {
    std::lock_guard<std::recursive_mutex> lock(_mutex);
    toml::table wrapped;
    wrapped.insert_or_assign("settings", _settings);
    return wrapped;
}

toml::table SettingsService::GetSettings(const std::string& container) {
    std::lock_guard<std::recursive_mutex> lock(_mutex);
    auto containerTable = _settings[container].as_table();
    if (!containerTable) {
        return toml::table{};
    }
    return *containerTable;
}

SettingValue SettingsService::GetSetting(const std::string& container, const std::string& name) {
    std::lock_guard<std::recursive_mutex> lock(_mutex);
    auto containerTable = _settings[container].as_table();
    if (!containerTable) {
        return SettingValue{};
    }
    return SettingValue{(*containerTable)[name]};
}

void SettingsService::SaveSettings(const toml::table& table) {
    auto settingsRoot = table["settings"].as_table();
    if (!settingsRoot) {
        throw std::invalid_argument("Table must contain 'settings' root key");
    }

    std::vector<UpdatedSettingNotification> notifications;
    {
    std::lock_guard<std::recursive_mutex> lock(_mutex);

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
                notifications.emplace_back(containerName.str(), key.str(), (*existingContainer)[key]);
            }
        }
    }
    }
    Fire(notifications);
}

void SettingsService::SaveSetting(const std::string& container, const std::string& name, const toml::node& value) {
    std::vector<UpdatedSettingNotification> notifications;
    {
        std::lock_guard<std::recursive_mutex> lock(_mutex);
        auto containerTable = _settings[container].as_table();
        if (!containerTable) {
            _settings.insert_or_assign(container, toml::table{});
            containerTable = _settings[container].as_table();
        }
        containerTable->insert_or_assign(name, value);
        WriteToFile();
        notifications.emplace_back(container, name, (*containerTable)[name]);
    }
    Fire(notifications);
}

void SettingsService::SaveSetting(const std::string& container, const std::string& name, const toml::node_view<const toml::node>& value) {
    if (value) {
        std::vector<UpdatedSettingNotification> notifications;
        {
            std::lock_guard<std::recursive_mutex> lock(_mutex);
            auto containerTable = _settings[container].as_table();
            if (!containerTable) {
                _settings.insert_or_assign(container, toml::table{});
                containerTable = _settings[container].as_table();
            }
            containerTable->insert_or_assign(name, *value.node());
            WriteToFile();
            notifications.emplace_back(container, name, (*containerTable)[name]);
        }
        Fire(notifications);
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
