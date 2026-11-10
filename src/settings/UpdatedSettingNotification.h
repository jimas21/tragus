// MagicPodsCore: https://github.com/steam3d/MagicPodsCore
// Copyright: 2020-2026 Aleksandr Maslov <https://magicpods.app> & Andrei Litvintsev <a.a.litvintsev@gmail.com>
// License: GPL-3.0

#pragma once

#include <string>
#include <string_view>
#include <toml++/toml.h>
#include "SettingValue.h"

namespace MagicPodsCore {

// Owns copies of the names and the value (Tragus): listeners run after the settings lock
// is released, so they must not point into the live settings table.
struct UpdatedSettingNotification {
private:
    std::string _containerName;
    std::string _settingName;
    SettingValue _value;

public:
    UpdatedSettingNotification(std::string_view containerName, std::string_view settingName, toml::node_view<toml::node> value)
    : _containerName(containerName), _settingName(settingName), _value(value) {}

    std::string_view GetContainerName() const {
        return _containerName;
    }

    std::string_view GetSettingName() const {
        return _settingName;
    }

    // Valid while this notification lives (listeners get it by reference).
    toml::node_view<toml::node> GetValue() const {
        return _value.view();
    }
};

}
