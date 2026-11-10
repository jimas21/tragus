// MagicPodsCore: https://github.com/steam3d/MagicPodsCore
// Copyright: 2020-2025 Aleksandr Maslov <https://magicpods.app> & Andrei Litvintsev <a.a.litvintsev@gmail.com>
// License: GPL-3.0

#pragma once

#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <utility>
#include <vector>

namespace MagicPodsCore {

    template<typename DataType>
    class Event {
    private:
        size_t _idForNewListener{};
        std::map<size_t, std::function<void(size_t, const DataType&)>> _listeners{};

    public:
        // TODO: обработать перемещение

        size_t Subscribe(std::function<void(size_t, const DataType&)>&& listener);
        void Unsubscribe(size_t listenerId);
        void FireEvent(const DataType& dataType);
    };

    template<typename DataType>
    size_t Event<DataType>::Subscribe(std::function<void(size_t, const DataType&)>&& listener) {
        _listeners.emplace(++_idForNewListener, listener);
        return _idForNewListener;
    }

    template<typename DataType>
    void Event<DataType>::Unsubscribe(size_t listenerId) {
        if (_listeners.find(listenerId) != _listeners.end())
            _listeners.erase(listenerId);
    }
    
    template<typename DataType>
    void Event<DataType>::FireEvent(const DataType& dataType) {
        for (auto& [key, value] : _listeners)
            value(key, dataType);
    }

    //TODO: Should I use a destructor or create a method called UnsubscribeAll?

    // Tragus: an Event that may be fired, subscribed to and unsubscribed from on different
    // threads at once (used for settings changes, which several threads save). Listeners
    // are called without the lock held, from a snapshot, and are skipped if they were
    // unsubscribed after the snapshot was taken.
    template<typename DataType>
    class ThreadSafeEvent {
    private:
        using Listener = std::function<void(size_t, const DataType&)>;
        struct Entry {
            Listener listener;
            bool subscribed{true};
        };
        std::mutex _mutex;
        size_t _idForNewListener{};
        std::map<size_t, std::shared_ptr<Entry>> _listeners{};

    public:
        size_t Subscribe(Listener&& listener) {
            std::lock_guard<std::mutex> lock(_mutex);
            auto entry = std::make_shared<Entry>();
            entry->listener = std::move(listener);
            _listeners.emplace(++_idForNewListener, std::move(entry));
            return _idForNewListener;
        }

        void Unsubscribe(size_t listenerId) {
            std::lock_guard<std::mutex> lock(_mutex);
            auto it = _listeners.find(listenerId);
            if (it != _listeners.end()) {
                it->second->subscribed = false;
                _listeners.erase(it);
            }
        }

        void FireEvent(const DataType& dataType) {
            std::vector<std::pair<size_t, std::shared_ptr<Entry>>> snapshot;
            {
                std::lock_guard<std::mutex> lock(_mutex);
                snapshot.assign(_listeners.begin(), _listeners.end());
            }
            for (auto& [key, entry] : snapshot) {
                bool subscribed;
                {
                    std::lock_guard<std::mutex> lock(_mutex);
                    subscribed = entry->subscribed;
                }
                if (subscribed)
                    entry->listener(key, dataType);
            }
        }
    };
}